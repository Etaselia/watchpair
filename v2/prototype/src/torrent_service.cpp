#include "torrent_service.h"
#include "native_runtime.h"
#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSaveFile>
#include <libtorrent/alert_types.hpp>
#include <libtorrent/magnet_uri.hpp>
#include <libtorrent/read_resume_data.hpp>
#include <libtorrent/settings_pack.hpp>
#include <libtorrent/torrent_flags.hpp>
#include <libtorrent/write_resume_data.hpp>

namespace lt = libtorrent;
namespace wp {
static lt::settings_pack settings(bool local) {
  lt::settings_pack s;
  s.set_str(lt::settings_pack::listen_interfaces, torrentListenInterface(local));
  s.set_bool(lt::settings_pack::enable_dht, !local);
  s.set_bool(lt::settings_pack::enable_lsd, !local);
  s.set_bool(lt::settings_pack::enable_upnp, false);
  s.set_bool(lt::settings_pack::enable_natpmp, false);
  s.set_bool(lt::settings_pack::allow_multiple_connections_per_ip, true);
  s.set_bool(lt::settings_pack::close_redundant_connections, !local);
  s.set_int(lt::settings_pack::alert_mask,
            lt::alert_category::error | lt::alert_category::storage | lt::alert_category::status |
                lt::alert_category::piece_progress | lt::alert_category::peer | lt::alert_category::connect);
  return s;
}
TorrentService::TorrentService(QString profile, QObject *parent, bool localOnly)
    : MediaSource(parent), session_(settings(localOnly)), profile_(std::move(profile)) {
  if (!QDir().mkpath(profile_))
    throw std::runtime_error("Cannot create the prototype profile directory.");
  connect(&timer_, &QTimer::timeout, this, &TorrentService::poll);
  timer_.start(25);
}
TorrentService::~TorrentService() {
  timer_.stop();
}
void TorrentService::add(const QString &source, const QString &directory, bool metadataOnly) {
  if (handle_.is_valid())
    throw std::runtime_error("This prototype opens one torrent at a time.");
  source_ = source;
  directory_ = QDir(directory).absolutePath();
  if (!QDir(directory_).entryList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden).isEmpty())
    throw std::runtime_error(
        "Use an empty prototype download directory. Reopen its profile to resume an existing transfer.");
  if (!QDir().mkpath(directory_))
    throw std::runtime_error("Cannot create the prototype download directory.");
  lt::add_torrent_params p;
  if (source.startsWith(QStringLiteral("magnet:")))
    p = lt::parse_magnet_uri(source.toStdString());
  else
    p.ti = std::make_shared<lt::torrent_info>(source.toStdString());
  p.save_path = directory_.toStdString();
  p.flags &= ~lt::torrent_flags::auto_managed;
  p.flags &= ~lt::torrent_flags::paused;
  if (metadataOnly)
    p.flags |= lt::torrent_flags::default_dont_download;
  handle_ = session_.add_torrent(p);
  manualPaused_ = false;
  saveIntent();
  emit activity(QStringLiteral("Torrent added; payload waits for an explicit file selection"));
  if (handle_.torrent_file())
    emit manifestChanged();
}
void TorrentService::select(const QList<int> &indexes) {
  auto info = handle_.torrent_file();
  if (!info)
    throw std::runtime_error("Wait for metadata before selecting files.");
  std::vector<lt::download_priority_t> priorities(info->num_files(), lt::dont_download);
  for (int i : indexes) {
    if (i < 0 || i >= info->num_files())
      throw std::runtime_error("File index is not in this manifest.");
    priorities.at(i) = lt::default_priority;
  }
  selected_ = indexes;
  handle_.prioritize_files(priorities);
  saveIntent();
  emit stateChanged();
}
void TorrentService::pause() {
  manualPaused_ = true;
  handle_.pause();
  saveIntent();
  emit stateChanged();
}
void TorrentService::resume() {
  manualPaused_ = false;
  handle_.resume();
  saveIntent();
  emit stateChanged();
}
void TorrentService::connectPeer(quint16 peerPort) {
  handle_.connect_peer({lt::make_address("127.0.0.1"), peerPort});
}
QList<TorrentFile> TorrentService::files() const {
  QList<TorrentFile> out;
  auto info = handle_.is_valid() ? handle_.torrent_file() : nullptr;
  if (!info)
    return out;
  const auto &storage = info->files();
  for (auto i : storage.file_range())
    out.append({static_cast<int>(i), QDir::fromNativeSeparators(QString::fromStdString(storage.file_path(i))),
                storage.file_size(i), storage.file_offset(i)});
  return out;
}
bool TorrentService::hasPiece(int piece) const {
  return handle_.is_valid() && piece >= 0 &&
         piece < (handle_.torrent_file() ? handle_.torrent_file()->num_pieces() : 0) &&
         handle_.have_piece(lt::piece_index_t(piece));
}
void TorrentService::requestPiece(int piece, int deadlineMs) {
  if (manualPaused_ || !handle_.is_valid() || hasPiece(piece))
    return;
  handle_.set_piece_deadline(lt::piece_index_t(piece), deadlineMs);
}
void TorrentService::cancelDeadline(int piece) {
  if (handle_.is_valid())
    handle_.reset_piece_deadline(lt::piece_index_t(piece));
}
void TorrentService::readPiece(int piece) {
  if (hasPiece(piece))
    handle_.read_piece(lt::piece_index_t(piece));
}
int TorrentService::pieceLength() const {
  auto info = handle_.is_valid() ? handle_.torrent_file() : nullptr;
  return info ? info->piece_length() : 0;
}
int TorrentService::pieceSize(int piece) const {
  auto info = handle_.is_valid() ? handle_.torrent_file() : nullptr;
  return info ? info->piece_size(lt::piece_index_t(piece)) : 0;
}
qint64 TorrentService::totalSize() const {
  auto info = handle_.is_valid() ? handle_.torrent_file() : nullptr;
  return info ? info->total_size() : 0;
}
quint16 TorrentService::port() const {
  return session_.listen_port();
}
double TorrentService::progress() const {
  return handle_.is_valid() ? handle_.status().progress : 0;
}
int TorrentService::peers() const {
  return handle_.is_valid() ? handle_.status().num_peers : 0;
}
QString TorrentService::label() const {
  return handle_.is_valid() ? QString::fromStdString(handle_.status().name) : QStringLiteral("No torrent");
}
void TorrentService::saveIntent() {
  QJsonArray choices;
  for (int index : selected_)
    choices.append(index);
  QSaveFile f(profile_ + QStringLiteral("/intent.json"));
  if (!f.open(QIODevice::WriteOnly))
    throw std::runtime_error("Cannot persist transfer intent.");
  f.write(QJsonDocument(QJsonObject{{QStringLiteral("source"), source_},
                                    {QStringLiteral("directory"), directory_},
                                    {QStringLiteral("paused"), manualPaused_},
                                    {QStringLiteral("selected"), choices}})
              .toJson());
  if (!f.commit())
    throw std::runtime_error("Cannot commit transfer intent.");
}
void TorrentService::loadIntent() {
  QFile f(profile_ + QStringLiteral("/intent.json"));
  if (!f.open(QIODevice::ReadOnly))
    return;
  const auto o = QJsonDocument::fromJson(f.readAll()).object();
  source_ = o.value(QStringLiteral("source")).toString();
  directory_ = o.value(QStringLiteral("directory")).toString();
  manualPaused_ = o.value(QStringLiteral("paused")).toBool();
  for (auto v : o.value(QStringLiteral("selected")).toArray())
    selected_.append(v.toInt());
}
void TorrentService::restore() {
  if (valid())
    return;
  loadIntent();
  if (source_.isEmpty())
    return;
  QFile resumeFile(profile_ + QStringLiteral("/resume.dat"));
  lt::add_torrent_params p;
  if (resumeFile.open(QIODevice::ReadOnly)) {
    const auto bytes = resumeFile.readAll();
    p = lt::read_resume_data(lt::span<const char>(bytes.constData(), bytes.size()));
  } else if (source_.startsWith(QStringLiteral("magnet:")))
    p = lt::parse_magnet_uri(source_.toStdString());
  else
    p.ti = std::make_shared<lt::torrent_info>(source_.toStdString());
  p.save_path = directory_.toStdString();
  p.flags &= ~lt::torrent_flags::auto_managed;
  if (manualPaused_)
    p.flags |= lt::torrent_flags::paused;
  else
    p.flags &= ~lt::torrent_flags::paused;
  if (p.ti) {
    p.file_priorities.assign(p.ti->num_files(), lt::dont_download);
    for (int i : selected_)
      if (i >= 0 && i < p.ti->num_files())
        p.file_priorities.at(i) = lt::default_priority;
  } else
    p.flags |= lt::torrent_flags::default_dont_download;
  handle_ = session_.add_torrent(p);
  emit manifestChanged();
  emit activity(
      QStringLiteral("Restored transfer; persisted manual pause and selection remain authoritative"));
}
void TorrentService::checkpoint() {
  if (!valid() || pendingResume_)
    return;
  pendingResume_ = true;
  handle_.save_resume_data(lt::torrent_handle::save_info_dict);
}
void TorrentService::poll() {
  std::vector<lt::alert *> alerts;
  session_.pop_alerts(&alerts);
  for (auto *a : alerts) {
    if (lt::alert_cast<lt::metadata_received_alert>(a)) {
      if (!selected_.isEmpty())
        select(selected_);
      emit manifestChanged();
    } else if (auto *read = lt::alert_cast<lt::read_piece_alert>(a)) {
      emit pieceRead(static_cast<int>(read->piece),
                     read->error ? QByteArray() : QByteArray(read->buffer.get(), read->size),
                     read->error ? QString::fromStdString(read->error.message()) : QString());
    } else if (auto *listen = lt::alert_cast<lt::listen_failed_alert>(a)) {
      error_ = QString::fromStdString(listen->error.message());
      emit activity(QStringLiteral("Torrent listener failed: ") + error_);
    } else if (auto *disconnected = lt::alert_cast<lt::peer_disconnected_alert>(a)) {
      emit activity(QStringLiteral("Peer disconnected: ") +
                    QString::fromStdString(disconnected->error.message()));
    } else if (auto *peerError = lt::alert_cast<lt::peer_error_alert>(a)) {
      emit activity(QStringLiteral("Peer error: ") + QString::fromStdString(peerError->error.message()));
    } else if (auto *done = lt::alert_cast<lt::piece_finished_alert>(a)) {
      emit pieceAvailable(static_cast<int>(done->piece_index));
    } else if (auto *saved = lt::alert_cast<lt::save_resume_data_alert>(a)) {
      auto bytes = lt::write_resume_data_buf(saved->params);
      QSaveFile file(profile_ + QStringLiteral("/resume.dat"));
      const bool committed = file.open(QIODevice::WriteOnly) &&
                             file.write(bytes.data(), bytes.size()) == qint64(bytes.size()) && file.commit();
      pendingResume_ = false;
      emit activity(committed ? QStringLiteral("Resume data checkpointed")
                              : QStringLiteral("Could not persist resume data"));
    } else if (auto *failed = lt::alert_cast<lt::save_resume_data_failed_alert>(a)) {
      pendingResume_ = false;
      emit activity(QStringLiteral("Could not checkpoint resume data: ") +
                    QString::fromStdString(failed->error.message()));
    } else if (auto *error = lt::alert_cast<lt::torrent_error_alert>(a)) {
      error_ = QString::fromStdString(error->error.message());
      emit activity(error_);
    }
  }
  emit stateChanged();
}
} // namespace wp
