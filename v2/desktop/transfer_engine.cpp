#include "transfer_engine.h"
#include "acquisition_state.h"
#include "native_runtime.h"
#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QSaveFile>
#include <QStorageInfo>
#include <QUrl>
#include <QUuid>
#include <algorithm>
#include <libtorrent/add_torrent_params.hpp>
#include <libtorrent/alert_types.hpp>
#include <libtorrent/announce_entry.hpp>
#include <libtorrent/ip_filter.hpp>
#include <libtorrent/magnet_uri.hpp>
#include <libtorrent/peer_info.hpp>
#include <libtorrent/read_resume_data.hpp>
#include <libtorrent/settings_pack.hpp>
#include <libtorrent/torrent_info.hpp>
#include <libtorrent/version.hpp>
#include <libtorrent/write_resume_data.hpp>
#include <sstream>

namespace lt = libtorrent;
namespace wp {
namespace {
QString uuid() {
  return QUuid::createUuid().toString(QUuid::WithoutBraces);
}
QString key(int index) {
  return QString::number(index);
}
QString safeComponent(QString name) {
  name.replace(QRegularExpression(QStringLiteral("[<>:\"/\\\\|?*\\x00-\\x1f]")), QStringLiteral("_"));
  while (name.endsWith(QLatin1Char('.')) || name.endsWith(QLatin1Char(' ')))
    name.chop(1);
  if (name.isEmpty() || name == QStringLiteral(".") || name == QStringLiteral(".."))
    name = QStringLiteral("file");
  const auto base = name.section(QLatin1Char('.'), 0, 0).toUpper();
  if (QRegularExpression(QStringLiteral("^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$"))
          .match(base)
          .hasMatch())
    name.prepend(QLatin1Char('_'));
  // Keep individual components portable, retaining the suffix.
  if (name.size() > 120 || name.toUtf8().size() > 200) {
    const auto suffix =
        QLatin1Char('-') +
        QString::fromLatin1(
            QCryptographicHash::hash(name.toUtf8(), QCryptographicHash::Sha256).toHex().left(12)) +
        QLatin1Char('.') + QFileInfo(name).suffix().left(12);
    auto stem = name.left(80);
    while (!stem.isEmpty() && (stem + suffix).toUtf8().size() > 200)
      stem.chop(1);
    if (!stem.isEmpty() && stem.back().isHighSurrogate())
      stem.chop(1);
    name = stem + suffix;
  }
  return name;
}
lt::settings_pack baseSettings(bool local) {
  lt::settings_pack s;
  // Start inert. Persisted proxy/offline/bind settings must be applied before
  // any discovery traffic or public listener can start.
  s.set_str(lt::settings_pack::listen_interfaces, "");
  s.set_bool(lt::settings_pack::enable_dht, false);
  s.set_bool(lt::settings_pack::enable_lsd, false);
  s.set_bool(lt::settings_pack::enable_upnp, false);
  s.set_bool(lt::settings_pack::enable_natpmp, false);
  s.set_bool(lt::settings_pack::allow_multiple_connections_per_ip, local);
  s.set_bool(lt::settings_pack::close_redundant_connections, !local);
  s.set_int(lt::settings_pack::alert_mask,
            lt::alert_category::error | lt::alert_category::storage | lt::alert_category::status |
                lt::alert_category::piece_progress | lt::alert_category::file_progress |
                lt::alert_category::tracker);
  s.set_int(lt::settings_pack::connections_limit, 300);
  return s;
}
QJsonArray trackerRows(const std::vector<lt::announce_entry> &trackers) {
  QJsonArray rows;
  for (const auto &tracker : trackers) {
    QJsonArray endpoints;
    for (const auto &ep : tracker.endpoints)
      for (const auto &h : ep.info_hashes)
        endpoints.append(
            QJsonObject{{QStringLiteral("failures"), int(h.fails)},
                        {QStringLiteral("message"), QString::fromStdString(h.message)},
                        {QStringLiteral("error"), QString::fromStdString(h.last_error.message())}});
    rows.append(QJsonObject{{QStringLiteral("url"), QString::fromStdString(tracker.url)},
                            {QStringLiteral("tier"), int(tracker.tier)},
                            {QStringLiteral("verified"), tracker.verified},
                            {QStringLiteral("endpoints"), endpoints}});
  }
  return rows;
}
QJsonArray peerRows(const std::vector<lt::peer_info> &peers) {
  QJsonArray rows;
  for (const auto &p : peers)
    rows.append(QJsonObject{{QStringLiteral("address"), QString::fromStdString(p.ip.address().to_string())},
                            {QStringLiteral("port"), p.ip.port()},
                            {QStringLiteral("client"), QString::fromStdString(p.client)},
                            {QStringLiteral("downRate"), p.down_speed},
                            {QStringLiteral("upRate"), p.up_speed},
                            {QStringLiteral("progress"), p.progress}});
  return rows;
}
} // namespace
TorrentTransfer::TorrentTransfer(TransferEngine &e, QString id) : engine_(e), id_(std::move(id)) {
}
QList<TorrentFile> TorrentTransfer::files() const {
  return engine_.record(id_).files;
}
bool TorrentTransfer::selected(int i) const {
  return engine_.record(id_).priorities.value(i) > 0;
}
bool TorrentTransfer::paused() const {
  return engine_.record(id_).physicalPause;
}
bool TorrentTransfer::hasPiece(int p) const {
  const auto &r = engine_.record(id_);
  const auto ti = r.handle.is_valid() ? r.handle.torrent_file() : nullptr;
  return ti && p >= 0 && p < ti->num_pieces() && r.handle.have_piece(lt::piece_index_t(p));
}
void TorrentTransfer::requestPiece(int p, int ms) {
  auto &r = engine_.record(id_);
  if (r.handle.is_valid() && !paused() && !hasPiece(p) && p >= 0 &&
      p < (r.handle.torrent_file() ? r.handle.torrent_file()->num_pieces() : 0))
    r.handle.set_piece_deadline(lt::piece_index_t(p), ms);
}
void TorrentTransfer::cancelDeadline(int p) {
  auto &r = engine_.record(id_);
  if (r.handle.is_valid())
    r.handle.reset_piece_deadline(lt::piece_index_t(p));
}
void TorrentTransfer::readPiece(int p) {
  if (hasPiece(p))
    engine_.record(id_).handle.read_piece(lt::piece_index_t(p));
}
int TorrentTransfer::pieceLength() const {
  const auto &h = engine_.record(id_).handle;
  auto ti = h.is_valid() ? h.torrent_file() : nullptr;
  return ti ? ti->piece_length() : 0;
}
int TorrentTransfer::pieceSize(int p) const {
  const auto &h = engine_.record(id_).handle;
  auto ti = h.is_valid() ? h.torrent_file() : nullptr;
  return ti && p >= 0 && p < ti->num_pieces() ? ti->piece_size(lt::piece_index_t(p)) : 0;
}
qint64 TorrentTransfer::totalSize() const {
  const auto &h = engine_.record(id_).handle;
  auto ti = h.is_valid() ? h.torrent_file() : nullptr;
  return ti ? ti->total_size() : 0;
}

TransferEngine::TransferEngine(LocalStore &store, QObject *parent, bool localOnly)
    : QObject(parent), store_(store), session_(std::make_unique<lt::session>(baseSettings(localOnly))),
      localOnly_(localOnly) {
  // Apply hard limits to LAN peers as well as public peers.
  lt::ip_filter filter;
  filter.add_rule(lt::make_address("0.0.0.0"), lt::make_address("255.255.255.255"), 1);
  filter.add_rule(lt::make_address("::"), lt::make_address("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"), 1);
  session_->set_peer_class_filter(filter);
  config_ = store_.setting(QStringLiteral("transfer"), QJsonObject()).toObject();
  for (auto v : store_.all(QStringLiteral("queue-order"))) {
    const auto row = v.toObject();
    const auto id = row.value(QStringLiteral("id")).toString();
    const auto kind = id.section(QLatin1Char(':'), 0, 0);
    const auto physicalId = id.section(QLatin1Char(':'), 1);
    const auto table = kind == QStringLiteral("torrent")  ? QStringLiteral("transfer")
                       : kind == QStringLiteral("direct") ? QStringLiteral("direct")
                                                          : QStringLiteral("share-download");
    if (store_.get(table, physicalId).isEmpty()) {
      store_.remove(QStringLiteral("queue-order"), id);
      continue;
    }
    const auto ordinal = row.value(QStringLiteral("order")).toInteger();
    orders_.insert(row.value(QStringLiteral("id")).toString(), ordinal);
    orderSequence_ = std::max(orderSequence_, ordinal + 1);
  }
  configure(config_);
  connect(&alerts_, &QTimer::timeout, this, &TransferEngine::poll);
  alerts_.start(40);
  connect(&updates_, &QTimer::timeout, this, &TransferEngine::update);
  updates_.start(1000);
  connect(&checkpoints_, &QTimer::timeout, this, &TransferEngine::checkpoint);
  checkpoints_.start(15000);
}
TransferEngine::~TransferEngine() {
  alerts_.stop();
  updates_.stop();
  checkpoints_.stop();
  session_->pause();
}
TransferEngine::Record &TransferEngine::record(const QString &id) const {
  auto it = records_.find(id);
  if (it == records_.end())
    throw AppError(QStringLiteral("TRANSFER_MISSING"), QStringLiteral("This transfer no longer exists."));
  return *it->second;
}
TorrentTransfer *TransferEngine::source(const QString &id) const {
  auto it = records_.find(id);
  return it == records_.end() ? nullptr : it->second->source.get();
}
QString TransferEngine::hashIdentity(const lt::info_hash_t &h) {
  std::ostringstream out;
  if (h.has_v2())
    out << h.v2;
  else if (h.has_v1())
    out << h.v1;
  return QStringLiteral("bt:") + QString::fromStdString(out.str());
}
bool TransferEngine::video(const QString &p) {
  static const QSet<QString> types{QStringLiteral("mkv"),  QStringLiteral("mp4"), QStringLiteral("m4v"),
                                   QStringLiteral("webm"), QStringLiteral("avi"), QStringLiteral("mov"),
                                   QStringLiteral("ts"),   QStringLiteral("m2ts")};
  return types.contains(QFileInfo(p).suffix().toLower());
}
bool TransferEngine::extra(const QString &p) {
  return QRegularExpression(
             QStringLiteral(
                 "(^|[/ _.-])(extras?|bonus|samples?|ncop|nced|pv|cm|trailers?|specials?)([/ _.-]|$)"),
             QRegularExpression::CaseInsensitiveOption)
      .match(p)
      .hasMatch();
}
QString TransferEngine::ownedDirectory(const QString &root, const QString &id, const QString &nonce) const {
  QDir parent(root.isEmpty() ? store_.profile() + QStringLiteral("/downloads") : root);
  if (!parent.exists() && !QDir().mkpath(parent.absolutePath()))
    throw AppError(QStringLiteral("STORAGE_ACCESS"), QStringLiteral("Cannot create the download directory."));
  // Every transfer gets a fresh owned child. An unrelated season folder is
  // never adopted, deleted, or left in a collision/retry loop.
  QString path;
  bool created = false;
  for (int attempt = 0; attempt < 16; ++attempt) {
    path = parent.absoluteFilePath(QStringLiteral("watchpair-") + id.left(12) +
                                   (attempt ? QLatin1Char('-') + uuid().left(8) : QString()));
    if (QFileInfo::exists(path))
      continue;
    if (parent.mkdir(QFileInfo(path).fileName())) {
      created = true;
      break;
    }
    path.clear();
  }
  if (!created || path.isEmpty() || QFileInfo(path).isSymLink())
    throw AppError(QStringLiteral("STORAGE_ACCESS"),
                   QStringLiteral("Cannot allocate a private transfer folder."));
  QSaveFile marker(path + QStringLiteral("/.watchpair-owner"));
  const auto bytes = QJsonDocument(QJsonObject{{QStringLiteral("id"), id}, {QStringLiteral("nonce"), nonce}})
                         .toJson(QJsonDocument::Compact);
  if (!marker.open(QIODevice::WriteOnly) || marker.write(bytes) != bytes.size() || !marker.commit())
    throw AppError(QStringLiteral("STORAGE_ACCESS"),
                   QStringLiteral("Cannot record transfer folder ownership."));
  return QDir(path).canonicalPath();
}
bool TransferEngine::owns(const QJsonObject &intent, const QString &path) const {
  QFileInfo directory(path);
  if (!directory.isDir() || directory.isSymLink() || directory.canonicalFilePath() != path)
    return false;
  QFile file(path + QStringLiteral("/.watchpair-owner"));
  if (QFileInfo(file).isSymLink() || !file.open(QIODevice::ReadOnly) || file.size() > 4096)
    return false;
  auto data = QJsonDocument::fromJson(file.readAll()).object();
  return data.value(QStringLiteral("id")) == intent.value(QStringLiteral("id")) &&
         data.value(QStringLiteral("nonce")) == intent.value(QStringLiteral("nonce"));
}
QString TransferEngine::add(const QString &source, const QString &root) {
  lt::add_torrent_params p;
  try {
    if (source.startsWith(QStringLiteral("magnet:")))
      p = lt::parse_magnet_uri(source.toStdString());
    else
      p.ti = std::make_shared<lt::torrent_info>(source.toStdString());
  } catch (...) {
    throw AppError(QStringLiteral("TORRENT_INVALID"),
                   QStringLiteral("This source is not a valid torrent or magnet link."));
  }
  const auto hashes = p.ti ? p.ti->info_hashes() : p.info_hashes;
  if (!hashes.has_v1() && !hashes.has_v2())
    throw AppError(QStringLiteral("TORRENT_INVALID"),
                   QStringLiteral("The torrent has no usable content identity."));
  // A hybrid v1/v2 source may refer to an existing transfer by either hash.
  for (auto &[id, r] : records_) {
    if (!r->handle.is_valid() || r->removing)
      continue;
    const auto h = r->handle.info_hashes();
    if ((hashes.has_v1() && h.has_v1() && hashes.v1 == h.v1) ||
        (hashes.has_v2() && h.has_v2() && hashes.v2 == h.v2))
      return id;
  }
  for (auto value : store_.all(QStringLiteral("retained-media"))) {
    auto retained = value.toObject();
    const auto id = retained.value(QStringLiteral("id")).toString();
    if (retained.value(QStringLiteral("kind")).toString() != QStringLiteral("torrent") ||
        retained.value(QStringLiteral("identity")).toString() != hashIdentity(hashes) ||
        !owns(retained, retained.value(QStringLiteral("path")).toString()))
      continue;
    retained.insert(QStringLiteral("source"), source);
    retained.insert(QStringLiteral("manualPaused"), true);
    retained.remove(QStringLiteral("removing"));
    retained.remove(QStringLiteral("deleteFiles"));
    retained.remove(QStringLiteral("deleteRequested"));
    store_.put(QStringLiteral("transfer"), id, retained);
    try {
      install(retained, true);
      store_.remove(QStringLiteral("retained-media"), id);
    } catch (...) {
      if (auto found = records_.find(id); found != records_.end()) {
        if (found->second->handle.is_valid())
          session_->remove_torrent(found->second->handle);
        records_.erase(found);
      }
      store_.remove(QStringLiteral("transfer"), id);
      throw;
    }
    emit added(id);
    emit changed();
    return id;
  }
  const auto id = uuid(), nonce = uuid();
  const auto path = ownedDirectory(
      root.isEmpty() ? config_.value(QStringLiteral("downloadRoot")).toString() : root, id, nonce);
  QJsonObject value{{QStringLiteral("id"), id},
                    {QStringLiteral("nonce"), nonce},
                    {QStringLiteral("source"), source},
                    {QStringLiteral("path"), path},
                    {QStringLiteral("identity"), hashIdentity(hashes)},
                    {QStringLiteral("manualPaused"), false},
                    {QStringLiteral("overrides"), QJsonObject()},
                    {QStringLiteral("order"), int(records_.size())},
                    {QStringLiteral("createdAt"), QDateTime::currentMSecsSinceEpoch()}};
  // Persist intent before the engine can receive any data.
  store_.put(QStringLiteral("transfer"), id, value);
  ensureOrder(QStringLiteral("torrent:") + id);
  try {
    install(value, false);
  } catch (...) {
    if (auto found = records_.find(id); found != records_.end()) {
      if (found->second->handle.is_valid())
        session_->remove_torrent(found->second->handle);
      records_.erase(found);
    }
    store_.remove(QStringLiteral("transfer"), id);
    forgetExternalWork(QStringLiteral("torrent:") + id);
    throw;
  }
  log(id, QStringLiteral("METADATA"),
      QStringLiteral("Added source. Fetching metadata; choose files before payload download."));
  emit added(id);
  emit changed();
  return id;
}
void TransferEngine::install(QJsonObject value, bool restoring) {
  const auto id = value.value(QStringLiteral("id")).toString();
  const auto path = value.value(QStringLiteral("path")).toString();
  if (!owns(value, path))
    throw AppError(QStringLiteral("STORAGE_OWNERSHIP"),
                   QStringLiteral("The transfer folder is missing or its ownership marker changed. Choose a "
                                  "new storage location or restore the original folder."));
  lt::add_torrent_params p;
  const auto resume = QByteArray::fromBase64(value.value(QStringLiteral("resume")).toString().toLatin1());
  if (!resume.isEmpty()) {
    lt::error_code ec;
    p = lt::read_resume_data(lt::span<const char>(resume.constData(), resume.size()), ec);
    if (ec) {
      log(id, QStringLiteral("RESUME_RECHECK"),
          QStringLiteral(
              "Resume data could not be read. Recovering from source metadata and verifying stored pieces."));
      p = {};
    }
  }
  if (!p.ti && !p.info_hashes.has_v1() && !p.info_hashes.has_v2()) {
    const auto src = value.value(QStringLiteral("source")).toString();
    if (src.startsWith(QStringLiteral("magnet:")))
      p = lt::parse_magnet_uri(src.toStdString());
    else
      p.ti = std::make_shared<lt::torrent_info>(src.toStdString());
  }
  p.save_path = path.toStdString();
  p.flags &= ~lt::torrent_flags::auto_managed;
  p.flags |= lt::torrent_flags::default_dont_download;
  p.flags |= lt::torrent_flags::paused; // validate manifest and durable priorities first
  if (p.ti)
    p.file_priorities.assign(p.ti->num_files(), lt::dont_download);
  auto r = std::make_unique<Record>();
  r->intent = value;
  r->source = std::make_unique<TorrentTransfer>(*this, id);
  r->handle = session_->add_torrent(p);
  auto *ptr = r.get();
  ensureOrder(QStringLiteral("torrent:") + id);
  records_.emplace(id, std::move(r));
  if (value.contains(QStringLiteral("trackers"))) {
    std::vector<lt::announce_entry> trackers;
    for (auto url : value.value(QStringLiteral("trackers")).toArray())
      trackers.emplace_back(url.toString().toStdString());
    ptr->handle.replace_trackers(trackers);
  }
  if (ptr->handle.torrent_file())
    manifest(*ptr);
  const auto job = store_.get(QStringLiteral("storage-job"), id);
  if (!job.isEmpty()) {
    // Restart a partially completed move using libtorrent's do-not-replace
    // semantics. Existing destination files are checked instead of overwritten.
    const auto destination = job.value(QStringLiteral("destination")).toString();
    if (!owns(value, destination)) {
      ptr->error = QStringLiteral("Storage move destination is missing. Restore it or retry the move.");
    } else
      ptr->handle.move_storage(destination.toStdString(), lt::move_flags_t::dont_replace);
  }
  if (restoring && value.value(QStringLiteral("removing")).toBool()) {
    ptr->removing = true;
    finishRemoval(*ptr);
    return;
  }
  applySelection(*ptr);
  schedule();
}
void TransferEngine::restore() {
  for (const auto value : store_.all(QStringLiteral("transfer"))) {
    const auto row = value.toObject();
    const auto id = row.value(QStringLiteral("id")).toString();
    if (records_.contains(id))
      continue;
    try {
      install(row, true);
      emit added(id);
    } catch (const std::exception &e) {
      if (!records_.contains(id)) {
        auto r = std::make_unique<Record>();
        r->intent = row;
        r->source = std::make_unique<TorrentTransfer>(*this, id);
        r->physicalPause = true;
        r->error = QString::fromUtf8(e.what());
        records_.emplace(id, std::move(r));
        emit added(id);
      } else {
        auto &r = record(id);
        r.error = QString::fromUtf8(e.what());
        if (r.handle.is_valid())
          r.handle.pause();
      }
      log(id, QStringLiteral("RESTORE_FAILED"), QString::fromUtf8(e.what()));
    }
  }
  emit changed();
}
void TransferEngine::persist(Record &r, QJsonObject value) {
  store_.put(QStringLiteral("transfer"), value.value(QStringLiteral("id")).toString(), value);
  r.intent = std::move(value);
}
void TransferEngine::manifest(Record &r) {
  auto ti = r.handle.torrent_file();
  if (!ti)
    return;
  // rename_file is posted to libtorrent's thread. Never retain a reference
  // into its mutable mapped storage while enqueueing disk-name changes.
  const lt::file_storage fs = ti->orig_files();
  if (fs.num_files() > 10000) {
    r.error = QStringLiteral("This pack contains more than 10,000 files. Split it into smaller sources.");
    r.handle.pause();
    return;
  }
  QList<TorrentFile> files;
  QList<QPair<int, QString>> renames;
  QSet<QString> normalized;
  QJsonObject diskPaths = r.intent.value(QStringLiteral("diskPaths")).toObject();
  QHash<int, QString> candidates;
  QSet<QString> directories;
  for (auto i : fs.file_range()) {
    if (fs.pad_file_at(i))
      continue;
    const auto path = QDir::fromNativeSeparators(QString::fromStdString(fs.file_path(i)));
    QStringList parts;
    for (const auto &part : path.split(QLatin1Char('/')))
      parts.append(safeComponent(part));
    QString disk = diskPaths.value(key(int(i))).toString(parts.join(QLatin1Char('/')));
    // Deep season folders must not exceed ordinary Windows path limits.
    // Original paths remain visible and retain their wire identity.
    const auto budget =
        std::max<qsizetype>(80, 235 - r.intent.value(QStringLiteral("path")).toString().size());
    if (!diskPaths.contains(key(int(i))) && disk.size() > budget) {
      const QFileInfo leaf(disk);
      disk = QStringLiteral("longpaths/%1-").arg(int(i)) + leaf.completeBaseName().left(40) +
             QLatin1Char('.') + leaf.suffix().left(12);
    }
    candidates.insert(int(i), disk);
    auto parent = disk.section(QLatin1Char('/'), 0, -2);
    while (!parent.isEmpty() && parent != disk) {
      directories.insert(parent.toCaseFolded());
      const auto slash = parent.lastIndexOf(QLatin1Char('/'));
      parent = slash < 0 ? QString() : parent.left(slash);
    }
  }
  for (auto i : fs.file_range()) {
    if (fs.pad_file_at(i))
      continue;
    const auto path = QDir::fromNativeSeparators(QString::fromStdString(fs.file_path(i)));
    if (fs.file_flags(i) & lt::file_storage::flag_symlink || path.startsWith(QLatin1Char('/')) ||
        path.split(QLatin1Char('/')).contains(QStringLiteral(".."))) {
      r.error =
          QStringLiteral("The torrent contains an unsafe path or symbolic link. No payload will download.");
      r.handle.pause();
      return;
    }
    files.append({int(i), path, fs.file_size(i), fs.file_offset(i)});
    QString disk = candidates.value(int(i));
    const QFileInfo name(disk);
    int suffix = 0;
    while (normalized.contains(disk.toCaseFolded()) || directories.contains(disk.toCaseFolded())) {
      const auto stem = name.completeBaseName() + QStringLiteral("-%1-%2").arg(int(i)).arg(++suffix);
      disk = (name.path() == QStringLiteral(".") ? QString() : name.path() + QLatin1Char('/')) + stem +
             (name.suffix().isEmpty() ? QString() : QLatin1Char('.') + name.suffix());
    }
    normalized.insert(disk.toCaseFolded());
    diskPaths.insert(key(int(i)), disk);
    // Original index and label remain the protocol identity; only disk names
    // are normalized for Windows/Linux compatibility.
    if (disk != path)
      renames.append({int(i), disk});
  }
  r.files = files;
  auto next = r.intent;
  next.insert(QStringLiteral("diskPaths"), diskPaths);
  next.insert(QStringLiteral("name"), QString::fromStdString(ti->name()));
  next.insert(QStringLiteral("identity"), hashIdentity(ti->info_hashes()));
  persist(r, next);
  for (const auto &rename : renames)
    r.handle.rename_file(lt::file_index_t(rename.first), rename.second.toStdString());
  applySelection(r);
  r.handle.save_resume_data(lt::torrent_handle::save_info_dict);
  r.pendingResume = true;
  emit r.source->manifestChanged();
  emit manifestReady(r.source->id());
}
void TransferEngine::applySelection(Record &r) {
  if (!r.handle.is_valid())
    return;
  auto ti = r.handle.torrent_file();
  if (!ti || !r.error.isEmpty())
    return;
  QHash<int, int> priorities;
  for (const auto value : store_.find(QStringLiteral("demand"), QStringLiteral("transfer"), r.source->id())) {
    const auto d = value.toObject();
    const auto policy = d.value(QStringLiteral("policy")).toString();
    bool pending = false;
    for (auto work : store_.find(QStringLiteral("publication"), QStringLiteral("binding"),
                                 d.value(QStringLiteral("id")).toString()))
      if (work.toObject().value(QStringLiteral("state")).toString() == QStringLiteral("pending"))
        pending = true;
    if (pending)
      continue;
    if (policy == QStringLiteral("Never") ||
        (policy == QStringLiteral("Ask") && !d.value(QStringLiteral("approved")).toBool()))
      continue;
    for (auto index : d.value(QStringLiteral("files")).toArray())
      priorities[index.toInt(-1)] = 4;
  }
  const auto overrides = r.intent.value(QStringLiteral("overrides")).toObject();
  for (auto it = overrides.begin(); it != overrides.end(); ++it)
    priorities[it.key().toInt()] = it.value().toInt();
  std::vector<lt::download_priority_t> native(ti->num_files(), lt::dont_download);
  QHash<int, int> valid;
  for (const auto &f : r.files) {
    const auto p = std::clamp(priorities.value(f.index), 0, 7);
    native.at(f.index) = lt::download_priority_t(p);
    if (p > 0)
      valid.insert(f.index, p);
  }
  r.priorities = valid;
  r.handle.prioritize_files(native);
  r.handle.set_download_limit(r.intent.value(QStringLiteral("downLimit")).toInt());
  r.handle.set_upload_limit(r.intent.value(QStringLiteral("upLimit")).toInt());
  emit r.source->stateChanged();
}
void TransferEngine::select(const QString &id, const QHash<int, int> &priorities) {
  auto &r = record(id);
  if (r.files.isEmpty())
    throw AppError(QStringLiteral("METADATA_WAIT"),
                   QStringLiteral("File choices will appear when metadata arrives."));
  QJsonObject overrides;
  QSet<int> valid;
  for (const auto &f : r.files)
    valid.insert(f.index);
  for (auto it = priorities.begin(); it != priorities.end(); ++it)
    if (!valid.contains(it.key()) || it.value() < 0 || it.value() > 7)
      throw AppError(QStringLiteral("FILE_SELECTION"),
                     QStringLiteral("A file choice is outside this torrent manifest."));
  // Applying a full local selection includes explicit refusals for unchecked
  // files, so a later shared edit cannot silently download them.
  for (int i : valid)
    overrides.insert(key(i), priorities.value(i));
  auto next = r.intent;
  next.insert(QStringLiteral("overrides"), overrides);
  next.insert(QStringLiteral("choiceRevision"), next.value(QStringLiteral("choiceRevision")).toInteger() + 1);
  persist(r, next);
  applySelection(r);
  schedule();
  emit changed();
}
void TransferEngine::followRoomSelection(const QString &id) {
  auto &r = record(id);
  auto next = r.intent;
  next.insert(QStringLiteral("overrides"), QJsonObject());
  next.insert(QStringLiteral("choiceRevision"), next.value(QStringLiteral("choiceRevision")).toInteger() + 1);
  persist(r, next);
  applySelection(r);
  schedule();
  emit changed();
}
void TransferEngine::overrideFiles(const QString &id, const QHash<int, int> &priorities) {
  auto &r = record(id);
  QSet<int> known;
  for (const auto &f : r.files)
    known.insert(f.index);
  auto overrides = r.intent.value(QStringLiteral("overrides")).toObject();
  for (auto it = priorities.begin(); it != priorities.end(); ++it) {
    if (!known.contains(it.key()) || it.value() < 0 || it.value() > 7)
      throw AppError(QStringLiteral("FILE_SELECTION"), QStringLiteral("Invalid file priority."));
    overrides.insert(key(it.key()), it.value());
  }
  auto next = r.intent;
  next.insert(QStringLiteral("overrides"), overrides);
  next.insert(QStringLiteral("choiceRevision"), next.value(QStringLiteral("choiceRevision")).toInteger() + 1);
  persist(r, next);
  applySelection(r);
  schedule();
  emit changed();
}
void TransferEngine::setDemand(const QString &k, const QString &id, const QList<int> &files,
                               const QString &policy, bool approved) {
  if (!QStringList{QStringLiteral("Auto"), QStringLiteral("Ask"), QStringLiteral("Never")}.contains(policy))
    throw AppError(QStringLiteral("POLICY"), QStringLiteral("Choose Auto, Ask, or Never."));
  QJsonArray indices;
  for (int i : files) {
    if (i < 0)
      throw AppError(QStringLiteral("FILE_SELECTION"), QStringLiteral("Invalid manifest index."));
    indices.append(i);
  }
  auto old = store_.get(QStringLiteral("demand"), k);
  QJsonObject d{{QStringLiteral("id"), k},
                {QStringLiteral("transfer"), id},
                {QStringLiteral("files"), indices},
                {QStringLiteral("policy"), policy},
                {QStringLiteral("approved"), approved}};
  if (old == d)
    return;
  store_.put(QStringLiteral("demand"), k, d);
  if (source(id)) {
    applySelection(record(id));
    schedule();
    emit changed();
  }
  const auto previous = old.value(QStringLiteral("transfer")).toString();
  if (previous != id && source(previous))
    applySelection(record(previous));
}
void TransferEngine::removeDemand(const QString &k) {
  const auto id = store_.get(QStringLiteral("demand"), k).value(QStringLiteral("transfer")).toString();
  store_.remove(QStringLiteral("demand"), k);
  if (source(id)) {
    applySelection(record(id));
    schedule();
    emit changed();
  }
}
void TransferEngine::setPaused(const QString &id, bool paused) {
  auto &r = record(id);
  auto next = r.intent;
  next.insert(QStringLiteral("manualPaused"), paused);
  persist(r, next);
  if (paused && r.handle.is_valid())
    r.handle.clear_piece_deadlines();
  schedule();
  emit changed();
}
void TransferEngine::setPinned(const QString &id, bool pinned) {
  auto &r = record(id);
  auto next = r.intent;
  next.insert(QStringLiteral("pinned"), pinned);
  persist(r, next);
  emit changed();
}
void TransferEngine::setLimits(const QString &id, int down, int up, double ratio, int minutes) {
  if (down < 0 || up < 0 || ratio < 0 || ratio > 1000 || minutes < 0)
    throw AppError(QStringLiteral("LIMIT_INVALID"),
                   QStringLiteral("Limits must be positive; zero means unlimited."));
  auto &r = record(id);
  auto next = r.intent;
  next.insert(QStringLiteral("downLimit"), down);
  next.insert(QStringLiteral("upLimit"), up);
  next.insert(QStringLiteral("seedRatio"), ratio);
  next.insert(QStringLiteral("seedMinutes"), minutes);
  persist(r, next);
  applySelection(r);
  schedule();
  emit changed();
}
void TransferEngine::setOrder(const QStringList &ids) {
  if (ids.size() != qsizetype(records_.size()) || QSet<QString>(ids.begin(), ids.end()).size() != ids.size())
    throw AppError(QStringLiteral("QUEUE_ORDER"),
                   QStringLiteral("The transfer list changed. Try reordering again."));
  for (const auto &id : ids)
    record(id);
  QList<qint64> positions;
  for (const auto &id : ids) {
    ensureOrder(QStringLiteral("torrent:") + id);
    positions.append(queueOrder(QStringLiteral("torrent:") + id));
  }
  std::sort(positions.begin(), positions.end());
  store_.transaction([&] {
    for (int i = 0; i < ids.size(); ++i) {
      auto value = record(ids[i]).intent;
      value.insert(QStringLiteral("order"), i);
      store_.put(QStringLiteral("transfer"), ids[i], value);
      store_.put(QStringLiteral("queue-order"), QStringLiteral("torrent:") + ids[i],
                 {{QStringLiteral("id"), QStringLiteral("torrent:") + ids[i]},
                  {QStringLiteral("order"), positions[i]}});
    }
  });
  for (int i = 0; i < ids.size(); ++i) {
    record(ids[i]).intent.insert(QStringLiteral("order"), i);
    orders_.insert(QStringLiteral("torrent:") + ids[i], positions[i]);
  }
  schedule();
  emit changed();
}
void TransferEngine::ensureOrder(const QString &key) {
  if (orders_.contains(key))
    return;
  store_.put(QStringLiteral("queue-order"), key,
             {{QStringLiteral("id"), key}, {QStringLiteral("order"), orderSequence_}});
  orders_.insert(key, orderSequence_++);
}
qint64 TransferEngine::queueOrder(const QString &key) const {
  return orders_.value(key, INT_MAX);
}
void TransferEngine::setExternalWork(const QString &key, bool wanted, bool foreground) {
  if (wanted)
    ensureOrder(key);
  const auto previous = externalWork_.value(key);
  if (previous.wanted == wanted && previous.foreground == foreground)
    return;
  externalWork_.insert(key, {wanted, foreground});
  schedule();
}
void TransferEngine::forgetExternalWork(const QString &key) {
  externalWork_.remove(key);
  orders_.remove(key);
  store_.remove(QStringLiteral("queue-order"), key);
  schedule();
}
void TransferEngine::moveQueue(const QString &key, int direction) {
  moveQueueGroup({key}, direction);
}
void TransferEngine::moveQueueGroup(const QStringList &selected, int direction) {
  if (selected.isEmpty())
    return;
  for (const auto &key : selected)
    ensureOrder(key);
  auto keys = orders_.keys();
  std::sort(keys.begin(), keys.end(),
            [this](const QString &a, const QString &b) { return queueOrder(a) < queueOrder(b); });
  QList<qint64> positions;
  for (const auto &key : keys)
    positions.append(queueOrder(key));
  const QSet<QString> wanted(selected.begin(), selected.end());
  if (direction < 0) {
    for (int i = 1; i < keys.size(); ++i)
      if (wanted.contains(keys[i]) && !wanted.contains(keys[i - 1]))
        keys.swapItemsAt(i, i - 1);
  } else
    for (int i = int(keys.size()) - 2; i >= 0; --i)
      if (wanted.contains(keys[i]) && !wanted.contains(keys[i + 1]))
        keys.swapItemsAt(i, i + 1);
  store_.transaction([&] {
    for (int i = 0; i < keys.size(); ++i)
      if (queueOrder(keys[i]) != positions[i])
        store_.put(QStringLiteral("queue-order"), keys[i],
                   {{QStringLiteral("id"), keys[i]}, {QStringLiteral("order"), positions[i]}});
  });
  for (int i = 0; i < keys.size(); ++i)
    orders_[keys[i]] = positions[i];
  schedule();
  emit changed();
}
QSet<QString> TransferEngine::downloadSlots() const {
  struct Candidate {
    QString key;
    bool foreground;
  };
  QList<Candidate> candidates;
  if (storageFailure_ || config_.value(QStringLiteral("offline")).toBool())
    return {};
  for (const auto &[id, r] : records_) {
    if (r->removing || !r->handle.is_valid() || r->intent.value(QStringLiteral("manualPaused")).toBool() ||
        !r->error.isEmpty() || r->priorities.isEmpty() ||
        !store_.get(QStringLiteral("storage-job"), id).isEmpty() ||
        (r->status.total_wanted > 0 && r->status.total_wanted_done >= r->status.total_wanted))
      continue;
    QStorageInfo disk(r->intent.value(QStringLiteral("path")).toString());
    if (disk.isValid() && disk.bytesAvailable() >= 0 &&
        disk.bytesAvailable() < qint64(config_.value(QStringLiteral("reserveMiB")).toInt(1024)) * 1024 * 1024)
      continue;
    candidates.append({QStringLiteral("torrent:") + id, r->playbackFile >= 0});
  }
  for (auto it = externalWork_.begin(); it != externalWork_.end(); ++it)
    if (it->wanted)
      candidates.append({it.key(), it->foreground});
  std::sort(candidates.begin(), candidates.end(), [this](const Candidate &a, const Candidate &b) {
    if (a.foreground != b.foreground)
      return a.foreground;
    const auto oa = queueOrder(a.key), ob = queueOrder(b.key);
    return oa == ob ? a.key < b.key : oa < ob;
  });
  QSet<QString> granted;
  const int limit = config_.value(QStringLiteral("concurrency")).toInt(3);
  for (const auto &c : candidates) {
    if (limit > 0 && granted.size() >= limit)
      break;
    granted.insert(c.key);
  }
  return granted;
}
bool TransferEngine::hasDownloadSlot(const QString &key) const {
  return downloadSlots().contains(key);
}
void TransferEngine::setPlayback(const QString &id, int index) {
  for (auto &[k, r] : records_) {
    const int next = k == id ? index : -1;
    if (r->playbackFile != next) {
      if (r->handle.is_valid())
        r->handle.clear_piece_deadlines();
      r->playbackFile = next;
    }
  }
  schedule();
}
void TransferEngine::recheck(const QString &id) {
  auto &r = record(id);
  if (!r.handle.is_valid())
    throw AppError(QStringLiteral("STORAGE_REPAIR"),
                   QStringLiteral("Restore or relocate this transfer before rechecking."));
  if (r.playbackFile >= 0 || !r.holds.isEmpty())
    throw AppError(QStringLiteral("TRANSFER_IN_USE"),
                   QStringLiteral("Wait for playback or file identification to finish before rechecking."));
  r.handle.force_recheck();
  log(id, QStringLiteral("RECHECK"), QStringLiteral("Verifying all stored pieces."));
}
void TransferEngine::retry(const QString &id) {
  if (storageFailure_) {
    store_.setSetting(QStringLiteral("lastStorageRepair"), QDateTime::currentMSecsSinceEpoch());
    storageFailure_ = false;
    session_->resume();
  }
  auto &r = record(id);
  if (!r.handle.is_valid()) {
    const auto value = r.intent;
    if (!owns(value, value.value(QStringLiteral("path")).toString()))
      throw AppError(QStringLiteral("STORAGE_OWNERSHIP"), r.error);
    records_.erase(id);
    install(value, true);
    emit changed();
    return;
  }
  const auto job = store_.get(QStringLiteral("storage-job"), id);
  if (!job.isEmpty()) {
    const auto destination = job.value(QStringLiteral("destination")).toString();
    if (!owns(r.intent, destination))
      throw AppError(QStringLiteral("STORAGE_OWNERSHIP"),
                     QStringLiteral("Restore the owned move destination before retrying."));
    r.handle.move_storage(destination.toStdString(), lt::move_flags_t::dont_replace);
  }
  r.error.clear();
  r.handle.clear_error();
  if (r.files.isEmpty() && r.handle.torrent_file())
    manifest(r);
  schedule();
  emit changed();
}
void TransferEngine::relocateMissing(const QString &id, const QString &root) {
  auto &r = record(id);
  if (r.handle.is_valid()) {
    move(id, root);
    return;
  }
  auto next = r.intent;
  next.insert(QStringLiteral("path"),
              ownedDirectory(root, id, next.value(QStringLiteral("nonce")).toString()));
  next.remove(QStringLiteral("resume"));
  store_.transaction([&] {
    store_.put(QStringLiteral("transfer"), id, next);
    store_.remove(QStringLiteral("storage-job"), id);
  });
  records_.erase(id);
  install(next, true);
  log(id, QStringLiteral("STORAGE_REPAIRED"),
      QStringLiteral("Allocated new managed storage. The unavailable previous folder was left untouched."));
  emit changed();
}
void TransferEngine::reannounce(const QString &id) {
  auto &r = record(id);
  if (!r.handle.is_valid())
    throw AppError(QStringLiteral("STORAGE_REPAIR"),
                   QStringLiteral("Restore or relocate this transfer before announcing."));
  r.handle.force_reannounce();
  r.handle.force_dht_announce();
}
void TransferEngine::setTrackers(const QString &id, const QStringList &urls) {
  std::vector<lt::announce_entry> trackers;
  for (const auto &raw : urls) {
    const QUrl url(raw);
    if (!url.isValid() ||
        !QStringList{QStringLiteral("udp"), QStringLiteral("http"), QStringLiteral("https")}.contains(
            url.scheme()) ||
        url.host().isEmpty())
      throw AppError(QStringLiteral("TRACKER_URL"),
                     QStringLiteral("A tracker must use udp://, http://, or https:// and include a host."));
    trackers.emplace_back(raw.toStdString());
  }
  auto &r = record(id);
  QJsonArray values;
  for (const auto &url : urls)
    values.append(url);
  auto next = r.intent;
  next.insert(QStringLiteral("trackers"), values);
  persist(r, next);
  r.handle.replace_trackers(trackers);
  r.trackersLoaded = false;
  r.trackerRows = {};
  r.detailsRequested = -10000;
  reannounce(id);
  checkpoint();
  emit changed();
}
void TransferEngine::move(const QString &id, const QString &root) {
  auto &r = record(id);
  if (r.playbackFile >= 0 || !r.holds.isEmpty() || !r.pendingHashes.isEmpty() || r.removing)
    throw AppError(
        QStringLiteral("TRANSFER_IN_USE"),
        QStringLiteral("Wait for playback or file identification to finish before moving these files."));
  if (!store_.get(QStringLiteral("storage-job"), id).isEmpty())
    throw AppError(QStringLiteral("MOVE_PENDING"),
                   QStringLiteral("A storage move already needs completion or repair."));
  if (!owns(r.intent, r.intent.value(QStringLiteral("path")).toString()))
    throw AppError(QStringLiteral("STORAGE_OWNERSHIP"),
                   QStringLiteral("The original storage folder is no longer owned by this transfer."));
  const auto destination = ownedDirectory(root, id, r.intent.value(QStringLiteral("nonce")).toString());
  store_.put(QStringLiteral("storage-job"), id,
             {{QStringLiteral("id"), id},
              {QStringLiteral("source"), r.intent.value(QStringLiteral("path"))},
              {QStringLiteral("destination"), destination}});
  r.handle.clear_piece_deadlines();
  schedule();
  r.handle.move_storage(destination.toStdString(), lt::move_flags_t::dont_replace);
  emit changed();
}
void TransferEngine::remove(const QString &id, bool deleteFiles) {
  auto &r = record(id);
  if (r.playbackFile >= 0 || !r.holds.isEmpty() || !r.pendingHashes.isEmpty() ||
      r.intent.value(QStringLiteral("pinned")).toBool())
    throw AppError(
        QStringLiteral("TRANSFER_PINNED"),
        QStringLiteral(
            "Wait for playback or identification to finish and unpin this transfer before removing it."));
  if (!store_.get(QStringLiteral("storage-job"), id).isEmpty())
    throw AppError(QStringLiteral("MOVE_PENDING"),
                   QStringLiteral("Complete or repair the storage move before removing this transfer."));
  if (deleteFiles && !owns(r.intent, r.intent.value(QStringLiteral("path")).toString()))
    throw AppError(QStringLiteral("STORAGE_OWNERSHIP"),
                   QStringLiteral("WatchPair cannot delete an unowned folder."));
  if (!r.handle.is_valid()) {
    if (deleteFiles)
      throw AppError(QStringLiteral("STORAGE_REPAIR"),
                     QStringLiteral("Restore this transfer before deleting its managed files."));
    store_.transaction([&] {
      refuseRoomAcquisition(store_, QStringLiteral("transfer"), id);
      auto retained = r.intent;
      retained.insert(QStringLiteral("kind"), QStringLiteral("torrent"));
      store_.put(QStringLiteral("retained-media"), id, retained);
      store_.remove(QStringLiteral("transfer"), id);
    });
    records_.erase(id);
    emit removed(id);
    forgetExternalWork(QStringLiteral("torrent:") + id);
    emit changed();
    return;
  }
  auto next = r.intent;
  next.insert(QStringLiteral("removing"), true);
  next.insert(QStringLiteral("deleteFiles"), deleteFiles);
  store_.transaction([&] {
    refuseRoomAcquisition(store_, QStringLiteral("transfer"), id);
    store_.put(QStringLiteral("transfer"), id, next);
    if (!deleteFiles) {
      auto retained = next;
      retained.insert(QStringLiteral("kind"), QStringLiteral("torrent"));
      store_.put(QStringLiteral("retained-media"), id, retained);
    }
  });
  r.intent = next;
  r.removing = true;
  r.handle.pause();
  finishRemoval(r);
}
void TransferEngine::finishRemoval(Record &r) {
  session_->remove_torrent(r.handle);
}
void TransferEngine::configure(const QJsonObject &value) {
  auto next = value;
  for (const auto &name :
       {QStringLiteral("downLimit"), QStringLiteral("upLimit"), QStringLiteral("reserveMiB"),
        QStringLiteral("concurrency"), QStringLiteral("connections"), QStringLiteral("port"),
        QStringLiteral("proxyPort")}) {
    if (next.contains(name) && (!next.value(name).isDouble() || next.value(name).toDouble() < 0 ||
                                next.value(name).toDouble() > 2147483647))
      throw AppError(QStringLiteral("NETWORK_SETTINGS"),
                     QStringLiteral("Network and storage limits must be valid positive numbers."));
  }
  if (next.value(QStringLiteral("port")).toInt() > 65535 ||
      next.value(QStringLiteral("proxyPort")).toInt() > 65535)
    throw AppError(QStringLiteral("NETWORK_SETTINGS"),
                   QStringLiteral("Ports must be between 1 and 65535, or zero for automatic."));
  const auto bind = next.value(QStringLiteral("bind")).toString();
  QHostAddress addr;
  if (!bind.isEmpty() && !addr.setAddress(bind))
    throw AppError(QStringLiteral("NETWORK_SETTINGS"),
                   QStringLiteral("Bind address must be an explicit IPv4 or IPv6 address."));
  lt::settings_pack s;
  s.set_int(lt::settings_pack::download_rate_limit, next.value(QStringLiteral("downLimit")).toInt());
  s.set_int(lt::settings_pack::upload_rate_limit, next.value(QStringLiteral("upLimit")).toInt());
  s.set_int(lt::settings_pack::connections_limit,
            std::clamp(next.value(QStringLiteral("connections")).toInt(300), 1, 10000));
  const auto proxy = next.value(QStringLiteral("proxyHost")).toString();
  const bool offline = next.value(QStringLiteral("offline")).toBool();
  if (!proxy.isEmpty() && next.value(QStringLiteral("proxyPort")).toInt(1080) == 0)
    throw AppError(QStringLiteral("NETWORK_SETTINGS"), QStringLiteral("Set a valid SOCKS5 proxy port."));
  s.set_bool(lt::settings_pack::enable_dht,
             !offline && proxy.isEmpty() && !localOnly_ && next.value(QStringLiteral("dht")).toBool(true));
  s.set_bool(lt::settings_pack::enable_lsd,
             !offline && proxy.isEmpty() && !localOnly_ && next.value(QStringLiteral("lsd")).toBool(true));
  s.set_bool(lt::settings_pack::enable_upnp,
             !offline && proxy.isEmpty() && !localOnly_ && next.value(QStringLiteral("upnp")).toBool());
  s.set_bool(lt::settings_pack::enable_natpmp,
             !offline && proxy.isEmpty() && !localOnly_ && next.value(QStringLiteral("upnp")).toBool());
  s.set_int(lt::settings_pack::proxy_type,
            proxy.isEmpty() ? lt::settings_pack::none : lt::settings_pack::socks5);
  s.set_str(lt::settings_pack::proxy_hostname, proxy.toStdString());
  s.set_int(lt::settings_pack::proxy_port, next.value(QStringLiteral("proxyPort")).toInt(1080));
  s.set_bool(lt::settings_pack::proxy_peer_connections, !proxy.isEmpty());
  s.set_bool(lt::settings_pack::proxy_tracker_connections, !proxy.isEmpty());
  s.set_bool(lt::settings_pack::proxy_hostnames, !proxy.isEmpty());
  s.set_str(lt::settings_pack::outgoing_interfaces, bind.toStdString());
  if (offline || !proxy.isEmpty())
    s.set_str(lt::settings_pack::listen_interfaces, "");
  else if (!bind.isEmpty()) {
    const auto address =
        addr.protocol() == QAbstractSocket::IPv6Protocol ? QLatin1Char('[') + bind + QLatin1Char(']') : bind;
    s.set_str(lt::settings_pack::listen_interfaces,
              (address + QLatin1Char(':') + QString::number(next.value(QStringLiteral("port")).toInt()))
                  .toStdString());
  } else if (!configured_ || config_.value(QStringLiteral("bind")) != next.value(QStringLiteral("bind")) ||
             config_.value(QStringLiteral("port")) != next.value(QStringLiteral("port")) ||
             config_.value(QStringLiteral("offline")) != next.value(QStringLiteral("offline")) ||
             config_.value(QStringLiteral("proxyHost")) != next.value(QStringLiteral("proxyHost"))) {
    s.set_str(lt::settings_pack::outgoing_interfaces, "");
    s.set_str(lt::settings_pack::listen_interfaces,
              next.value(QStringLiteral("port")).toInt()
                  ? std::string(localOnly_ ? "127.0.0.1:" : "0.0.0.0:") +
                        std::to_string(next.value(QStringLiteral("port")).toInt())
                  : torrentListenInterface(localOnly_));
  }
  store_.setSetting(QStringLiteral("transfer"), next);
  config_ = next;
  configured_ = true;
  session_->apply_settings(s);
  schedule();
  emit changed();
  const auto http = traffic_.value(QStringLiteral("http"));
  setExternalTraffic(http.first, http.second);
}
QJsonObject TransferEngine::configuration() const {
  return config_;
}
int TransferEngine::externalDownLimit() const {
  const int total = config_.value(QStringLiteral("downLimit")).toInt();
  if (total <= 0 || externalDownloads_ <= 0)
    return 0;
  bool native = false;
  for (const auto &[_, r] : records_)
    if (r->handle.is_valid() && !r->physicalPause && !r->removing && !r->priorities.isEmpty() &&
        !(r->status.total_wanted > 0 && r->status.total_wanted_done >= r->status.total_wanted))
      native = true;
  return native ? std::max(1, total / 2) : total;
}
int TransferEngine::externalUpLimit() const {
  const int total = config_.value(QStringLiteral("upLimit")).toInt();
  if (total <= 0 || externalUploads_ <= 0)
    return 0;
  bool native = false;
  for (const auto &[_, r] : records_)
    if (r->handle.is_valid() && !r->physicalPause && !r->removing &&
        (!r->priorities.isEmpty() || r->status.total_done > 0))
      native = true;
  return native ? std::max(1, total / 2) : total;
}
void TransferEngine::setExternalTraffic(int down, int up) {
  setExternalTrafficFor(QStringLiteral("http"), down, up);
}
void TransferEngine::setExternalTrafficFor(const QString &transport, int down, int up) {
  traffic_.insert(transport, {std::max(0, down), std::max(0, up)});
  down = 0;
  up = 0;
  for (auto value : traffic_) {
    down += value.first;
    up += value.second;
  }
  externalDownloads_ = std::max(0, down);
  externalUploads_ = std::max(0, up);
  lt::settings_pack s;
  const int downTotal = config_.value(QStringLiteral("downLimit")).toInt();
  const int upTotal = config_.value(QStringLiteral("upLimit")).toInt();
  s.set_int(lt::settings_pack::download_rate_limit,
            downTotal ? std::max(1, downTotal - externalDownLimit()) : 0);
  s.set_int(lt::settings_pack::upload_rate_limit, upTotal ? std::max(1, upTotal - externalUpLimit()) : 0);
  session_->apply_settings(s);
  downBudget_->bytesPerSecond.store(externalDownLimit());
  upBudget_->bytesPerSecond.store(externalUpLimit());
  schedule();
}
void TransferEngine::schedule() {
  std::vector<Record *> ordered;
  for (auto &[id, r] : records_)
    ordered.push_back(r.get());
  std::stable_sort(ordered.begin(), ordered.end(), [](const Record *a, const Record *b) {
    if ((a->playbackFile >= 0) != (b->playbackFile >= 0))
      return a->playbackFile >= 0;
    return a->intent.value(QStringLiteral("order")).toInt() <
           b->intent.value(QStringLiteral("order")).toInt();
  });
  const auto grantedSlots = downloadSlots();
  const bool offline = config_.value(QStringLiteral("offline")).toBool();
  for (auto *r : ordered) {
    if (r->removing || !r->handle.is_valid()) {
      r->physicalPause = true;
      r->reason = r->removing ? QStringLiteral("Removing transfer") : r->error;
      continue;
    }
    QString reason;
    const auto id = r->source->id();
    const bool selected = !r->priorities.isEmpty();
    const bool completed =
        r->status.total_wanted > 0 && r->status.total_wanted_done >= r->status.total_wanted;
    if (storageFailure_)
      reason = QStringLiteral("Local state cannot be saved");
    else if (r->removing)
      reason = QStringLiteral("Removing transfer");
    else if (r->intent.value(QStringLiteral("manualPaused")).toBool())
      reason = QStringLiteral("Paused by you");
    else if (offline)
      reason = QStringLiteral("Offline mode");
    else if ((externalDownloads_ > 0 && config_.value(QStringLiteral("downLimit")).toInt() == 1) ||
             (externalUploads_ > 0 && config_.value(QStringLiteral("upLimit")).toInt() == 1))
      reason = QStringLiteral("Device bandwidth allocated to another transfer");
    else if (!r->error.isEmpty())
      reason = r->error;
    else if (!store_.get(QStringLiteral("storage-job"), id).isEmpty())
      reason = QStringLiteral("Moving storage");
    else if (selected && !completed) {
      QStorageInfo disk(r->intent.value(QStringLiteral("path")).toString());
      const qint64 reserve = qint64(config_.value(QStringLiteral("reserveMiB")).toInt(1024)) * 1024 * 1024;
      if (disk.isValid() && disk.bytesAvailable() >= 0 && disk.bytesAvailable() < reserve)
        reason = QStringLiteral("Waiting for free space reserve");
      else if (!grantedSlots.contains(QStringLiteral("torrent:") + id))
        reason = QStringLiteral("Waiting for a download slot");
    } else if (completed) {
      const auto ratio = r->intent.value(QStringLiteral("seedRatio")).toDouble();
      const auto minutes = r->intent.value(QStringLiteral("seedMinutes")).toInt();
      if (ratio > 0 && r->status.all_time_upload >= ratio * std::max<qint64>(1, r->status.all_time_download))
        reason = QStringLiteral("Seeding ratio reached");
      else if (minutes > 0 && r->status.seeding_duration.count() >= qint64(minutes) * 60)
        reason = QStringLiteral("Seeding time reached");
    }
    const bool paused = !reason.isEmpty();
    if (r->physicalPause != paused || bool(r->handle.flags() & lt::torrent_flags::paused) != paused) {
      if (paused) {
        r->handle.clear_piece_deadlines();
        r->handle.pause();
      } else
        r->handle.resume();
    }
    r->physicalPause = paused;
    r->reason = reason;
    if (!selected && r->handle.torrent_file() && !paused)
      r->reason = QStringLiteral("Choose files or approve this device's download policy");
  }
}
void TransferEngine::update() {
  try {
    session_->post_torrent_updates();
    schedule();
  } catch (const std::exception &e) {
    storageFailure_ = true;
    session_->pause();
    log({}, QStringLiteral("STATE_SAVE_FAILED"), QString::fromUtf8(e.what()));
  }
}
TransferEngine::Record *TransferEngine::byHandle(const lt::torrent_handle &h) const {
  for (const auto &[id, r] : records_)
    if (r->handle == h)
      return r.get();
  return nullptr;
}
void TransferEngine::poll() {
  try {
    std::vector<lt::alert *> alerts;
    session_->pop_alerts(&alerts);
    bool changed = false;
    for (auto *a : alerts) {
      if (auto *status = lt::alert_cast<lt::state_update_alert>(a)) {
        for (const auto &s : status->status)
          if (auto *r = byHandle(s.handle)) {
            r->status = s;
            emit r->source->stateChanged();
          }
        changed = true;
        continue;
      }
      auto *ta = dynamic_cast<lt::torrent_alert *>(a);
      auto *r = ta ? byHandle(ta->handle) : nullptr;
      if (!r) {
        if (auto *failed = lt::alert_cast<lt::listen_failed_alert>(a))
          log({}, QStringLiteral("LISTEN_FAILED"),
              QStringLiteral("Torrent listener could not bind: ") +
                  QString::fromStdString(failed->error.message()));
        continue;
      }
      const auto id = r->source->id();
      if (auto *files = lt::alert_cast<lt::file_progress_alert>(a)) {
        r->progress.clear();
        r->progress.reserve(files->files.size());
        for (auto bytes : files->files)
          r->progress.append(bytes);
        emit detailsChanged(id);
      } else if (auto *trackers = lt::alert_cast<lt::tracker_list_alert>(a)) {
        r->trackerRows = trackerRows(trackers->trackers);
        r->trackersLoaded = true;
        emit detailsChanged(id);
      } else if (auto *peers = lt::alert_cast<lt::peer_info_alert>(a)) {
        r->peerRows = peerRows(peers->peer_info);
        emit detailsChanged(id);
      } else if (lt::alert_cast<lt::metadata_received_alert>(a)) {
        manifest(*r);
        schedule();
        changed = true;
      } else if (auto *read = lt::alert_cast<lt::read_piece_alert>(a))
        emit r->source->pieceRead(int(read->piece),
                                  read->error ? QByteArray() : QByteArray(read->buffer.get(), read->size),
                                  read->error ? QString::fromStdString(read->error.message()) : QString());
      else if (auto *piece = lt::alert_cast<lt::piece_finished_alert>(a))
        emit r->source->pieceAvailable(int(piece->piece_index));
      else if (auto *complete = lt::alert_cast<lt::file_completed_alert>(a))
        emit fileComplete(id, int(complete->index));
      else if (lt::alert_cast<lt::cache_flushed_alert>(a) && !r->pendingHashes.isEmpty()) {
        const auto pending = r->pendingHashes;
        r->pendingHashes.clear();
        const auto status = r->handle.status(lt::torrent_handle::query_pieces);
        const auto root = r->intent.value(QStringLiteral("path")).toString();
        for (int index : pending) {
          auto file = std::find_if(r->files.begin(), r->files.end(),
                                   [index](const auto &f) { return f.index == index; });
          if (file == r->files.end() || file->size <= 0 || !owns(r->intent, root)) {
            emit identificationUnavailable(id, index);
            continue;
          }
          const auto length = r->source->pieceLength();
          if (length <= 0) {
            emit identificationUnavailable(id, index);
            continue;
          }
          const int first = int(file->offset / length), last = int((file->offset + file->size - 1) / length);
          bool verified = last < status.pieces.size();
          for (int p = first; verified && p <= last; ++p)
            verified = status.pieces[lt::piece_index_t(p)];
          const auto relative =
              r->intent.value(QStringLiteral("diskPaths")).toObject().value(key(index)).toString();
          const QFileInfo disk(QDir(root).absoluteFilePath(relative));
          const auto canonical = disk.canonicalFilePath();
          if (verified && disk.isFile() && !disk.isSymLink() && disk.size() == file->size &&
              canonical.startsWith(QDir(root).canonicalPath() + QLatin1Char('/')))
            emit fileReadyForIdentification(id, index, canonical);
          else
            emit identificationUnavailable(id, index);
        }
      } else if (auto *saved = lt::alert_cast<lt::save_resume_data_alert>(a)) {
        auto bytes = lt::write_resume_data_buf(saved->params);
        auto next = r->intent;
        next.insert(QStringLiteral("resume"),
                    QString::fromLatin1(QByteArray(bytes.data(), bytes.size()).toBase64()));
        persist(*r, next);
        r->pendingResume = false;
      } else if (lt::alert_cast<lt::save_resume_data_failed_alert>(a))
        r->pendingResume = false;
      else if (auto *moved = lt::alert_cast<lt::storage_moved_alert>(a)) {
        const auto old = r->intent.value(QStringLiteral("path")).toString();
        auto next = r->intent;
        next.insert(QStringLiteral("path"), QString::fromStdString(moved->storage_path()));
        if (!owns(next, next.value(QStringLiteral("path")).toString())) {
          r->error =
              QStringLiteral("Moved storage has no valid ownership marker. Transfer paused for repair.");
          r->handle.pause();
          continue;
        }
        store_.transaction([&] {
          store_.put(QStringLiteral("transfer"), id, next);
          store_.remove(QStringLiteral("storage-job"), id);
        });
        r->intent = next;
        // Only remove our marker and now-empty directories; unrelated files survive.
        if (owns(next, old)) {
          QFile::remove(old + QStringLiteral("/.watchpair-owner"));
          QDir().rmdir(old);
        }
        r->handle.force_recheck();
        log(id, QStringLiteral("STORAGE_MOVED"),
            QStringLiteral("Storage moved; verifying destination files."));
        schedule();
        checkpoint();
        changed = true;
      } else if (auto *failed = lt::alert_cast<lt::storage_moved_failed_alert>(a)) {
        r->error = QStringLiteral("Storage move failed: ") + QString::fromStdString(failed->error.message());
        log(id, QStringLiteral("MOVE_FAILED"), r->error);
        changed = true;
      } else if (auto *failed = lt::alert_cast<lt::file_rename_failed_alert>(a)) {
        r->error = QStringLiteral("A portable disk filename could not be created: ") +
                   QString::fromStdString(failed->error.message());
        r->handle.pause();
        log(id, QStringLiteral("TORRENT_ERROR"), r->error);
        changed = true;
      } else if (auto *failed = lt::alert_cast<lt::torrent_error_alert>(a)) {
        r->error = QString::fromStdString(failed->error.message());
        log(id, QStringLiteral("TORRENT_ERROR"), r->error);
        schedule();
        changed = true;
      } else if (lt::alert_cast<lt::torrent_removed_alert>(a) && r->removing) {
        const auto row = r->intent;
        const auto root = row.value(QStringLiteral("path")).toString();
        bool deletionFailed = row.value(QStringLiteral("deleteFiles")).toBool() && !owns(row, root);
        if (row.value(QStringLiteral("deleteFiles")).toBool() && owns(row, root)) {
          const auto paths = row.value(QStringLiteral("diskPaths")).toObject();
          for (auto it = paths.begin(); it != paths.end(); ++it) {
            const auto relative = it.value().toString();
            const auto absolute = QDir(root).absoluteFilePath(relative);
            const auto canonicalParent = QFileInfo(absolute).dir().canonicalPath();
            const auto canonicalRoot = QDir(root).canonicalPath();
            if (!QFileInfo::exists(absolute) && !QFileInfo(absolute).isSymLink())
              continue;
            if (!canonicalParent.startsWith(canonicalRoot + QLatin1Char('/')) &&
                canonicalParent != canonicalRoot) {
              deletionFailed = true;
              continue;
            }
            if (QFileInfo(absolute).isSymLink() || !QFile::remove(absolute)) {
              deletionFailed = true;
              continue;
            }
            QDir parent = QFileInfo(absolute).dir();
            while (parent.absolutePath() != canonicalRoot &&
                   parent.entryList(QDir::AllEntries | QDir::Hidden | QDir::NoDotAndDotDot).isEmpty()) {
              const auto name = parent.dirName();
              parent.cdUp();
              if (!parent.rmdir(name))
                break;
            }
          }
          if (!deletionFailed &&
              QDir(root).entryList(QDir::AllEntries | QDir::Hidden | QDir::NoDotAndDotDot) ==
                  QStringList{QStringLiteral(".watchpair-owner")}) {
            QFile::remove(root + QStringLiteral("/.watchpair-owner"));
            QDir().rmdir(root);
          }
        }
        store_.transaction([&] {
          if (deletionFailed) {
            auto retained = row;
            retained.insert(QStringLiteral("kind"), QStringLiteral("torrent"));
            retained.insert(QStringLiteral("deleteRequested"), true);
            store_.put(QStringLiteral("retained-media"), id, retained);
          }
          store_.remove(QStringLiteral("transfer"), id);
        });
        if (deletionFailed)
          log(id, QStringLiteral("STORAGE_DELETE"),
              QStringLiteral("Some managed files could not be deleted. Review and retry them in Storage."));
        records_.erase(id);
        emit removed(id);
        forgetExternalWork(QStringLiteral("torrent:") + id);
        changed = true;
      }
    }
    if (changed)
      emit this->changed();
  } catch (const std::exception &e) {
    storageFailure_ = true;
    session_->pause();
    log({}, QStringLiteral("STATE_SAVE_FAILED"), QString::fromUtf8(e.what()));
    emit changed();
  }
}
void TransferEngine::checkpoint() {
  for (auto &[id, r] : records_)
    if (!r->pendingResume && !r->removing && r->handle.is_valid()) {
      r->pendingResume = true;
      r->handle.save_resume_data(lt::torrent_handle::save_info_dict);
    }
}
int TransferEngine::pendingCheckpoints() const {
  int n = 0;
  for (const auto &[id, r] : records_)
    if (r->pendingResume)
      ++n;
  return n;
}
quint16 TransferEngine::port() const {
  return session_->listen_port();
}
void TransferEngine::connectPeer(const QString &id, const QString &address, quint16 port) {
  record(id).handle.connect_peer({lt::make_address(address.toStdString()), port});
}
QString TransferEngine::magnet(const QString &id) const {
  const auto &r = record(id);
  if (!r.handle.is_valid())
    throw AppError(QStringLiteral("METADATA_WAIT"),
                   QStringLiteral("Restore this source before sharing its manifest."));
  return QString::fromStdString(lt::make_magnet_uri(r.handle));
}
bool TransferEngine::matchesIdentity(const QString &id, const QString &identity) const {
  const auto &r = record(id);
  if (!r.handle.is_valid())
    return false;
  const auto hashes = r.handle.info_hashes();
  std::ostringstream v1, v2;
  if (hashes.has_v1())
    v1 << hashes.v1;
  if (hashes.has_v2())
    v2 << hashes.v2;
  return (hashes.has_v1() && identity == QStringLiteral("bt:") + QString::fromStdString(v1.str())) ||
         (hashes.has_v2() && identity == QStringLiteral("bt:") + QString::fromStdString(v2.str()));
}
bool TransferEngine::requestIdentifiedCopy(const QString &id, int index) {
  auto &r = record(id);
  if (!r.handle.is_valid() || r.removing || r.pendingHashes.contains(index))
    return false;
  if (!std::any_of(r.files.begin(), r.files.end(), [index](const auto &f) { return f.index == index; }))
    throw AppError(QStringLiteral("FILE_SELECTION"),
                   QStringLiteral("That file is not in this torrent manifest."));
  r.pendingHashes.insert(index);
  r.handle.flush_cache();
  return true;
}
void TransferEngine::hold(const QString &id, const QString &token) {
  record(id).holds.insert(token);
  emit changed();
}
void TransferEngine::releaseHold(const QString &id, const QString &token) {
  auto it = records_.find(id);
  if (it == records_.end())
    return;
  it->second->holds.remove(token);
  emit changed();
}
void TransferEngine::reloadIntent(const QString &id) {
  auto &r = record(id);
  const auto value = store_.get(QStringLiteral("transfer"), id);
  if (value.isEmpty())
    return;
  r.intent = value;
  applySelection(r);
  schedule();
  emit changed();
}
QJsonObject TransferEngine::intent(const QString &id) const {
  return record(id).intent;
}
TransferView TransferEngine::view(const QString &id) const {
  const auto &r = record(id);
  const auto &s = r.status;
  TransferView v;
  v.id = id;
  v.name = r.intent.value(QStringLiteral("name")).toString(QStringLiteral("Retrieving metadata…"));
  v.path = r.intent.value(QStringLiteral("path")).toString();
  v.identity = r.intent.value(QStringLiteral("identity")).toString();
  v.error = r.error;
  v.reason = r.reason;
  v.metadata = !r.files.isEmpty();
  v.manualPaused = r.intent.value(QStringLiteral("manualPaused")).toBool();
  v.pinned = r.intent.value(QStringLiteral("pinned")).toBool();
  v.moving = !store_.get(QStringLiteral("storage-job"), id).isEmpty();
  v.inUse = r.playbackFile >= 0 || !r.holds.isEmpty() || !r.pendingHashes.isEmpty();
  // Native telemetry arrives asynchronously after file choices. Show the
  // committed selection immediately, rather than an old zero-byte/seeding row.
  for (const auto &file : r.files)
    if (r.priorities.contains(file.index))
      v.wanted += file.size;
  v.verified = s.total_wanted == v.wanted ? std::min<qint64>(v.wanted, s.total_wanted_done) : 0;
  v.downloaded = s.all_time_download;
  v.uploaded = s.all_time_upload;
  v.downRate = s.download_payload_rate;
  v.upRate = s.upload_payload_rate;
  v.peers = s.num_peers;
  v.seeds = s.num_seeds;
  v.availability = s.distributed_copies;
  v.order =
      int(std::min<qint64>(INT_MAX - 1, orders_.value(QStringLiteral("torrent:") + id,
                                                      r.intent.value(QStringLiteral("order")).toInt())));
  if (!r.error.isEmpty())
    v.state = QStringLiteral("Error");
  else if (r.physicalPause)
    v.state = v.manualPaused ? QStringLiteral("Paused") : QStringLiteral("Waiting");
  else if (!v.metadata)
    v.state = QStringLiteral("Metadata");
  else if (r.priorities.isEmpty())
    v.state = QStringLiteral("Select files");
  else if (s.total_wanted != v.wanted)
    v.state = QStringLiteral("Updating selection");
  else if (s.state == lt::torrent_status::checking_files ||
           s.state == lt::torrent_status::checking_resume_data)
    v.state = QStringLiteral("Checking");
  else if (s.is_finished && v.wanted > 0 && v.verified >= v.wanted)
    v.state = QStringLiteral("Seeding");
  else if (s.num_peers == 0 && s.download_payload_rate == 0)
    v.state = QStringLiteral("Stalled");
  else
    v.state = QStringLiteral("Downloading");
  return v;
}
QList<TransferView> TransferEngine::transfers() const {
  QList<TransferView> out;
  for (const auto &[id, r] : records_)
    out.append(view(id));
  std::sort(out.begin(), out.end(), [](const auto &a, const auto &b) { return a.order < b.order; });
  return out;
}
QList<qint64> TransferEngine::fileProgress(const QString &id) const {
  requestDetails(id);
  return record(id).progress;
}
QJsonArray TransferEngine::trackers(const QString &id) const {
  requestDetails(id);
  const auto &r = record(id);
  if (!r.trackersLoaded && r.intent.contains(QStringLiteral("trackers"))) {
    QJsonArray rows;
    for (auto v : r.intent.value(QStringLiteral("trackers")).toArray())
      rows.append(QJsonObject{{QStringLiteral("url"), v}});
    return rows;
  }
  return r.trackerRows;
}
QJsonArray TransferEngine::peers(const QString &id) const {
  requestDetails(id);
  return record(id).peerRows;
}
bool TransferEngine::trackersReady(const QString &id) const {
  return record(id).trackersLoaded || record(id).intent.contains(QStringLiteral("trackers"));
}
void TransferEngine::requestDetails(const QString &id) const {
  auto &r = record(id);
  const auto now = QDateTime::currentMSecsSinceEpoch();
  if (!r.handle.is_valid() || r.removing || now - r.detailsRequested < 1000)
    return;
  r.detailsRequested = now;
  r.handle.post_file_progress(lt::torrent_handle::piece_granularity);
  r.handle.post_peer_info();
  r.handle.post_trackers();
}
void TransferEngine::log(const QString &id, const QString &code, const QString &text) {
  activity_.append(QJsonObject{{QStringLiteral("at"), QDateTime::currentMSecsSinceEpoch()},
                               {QStringLiteral("transfer"), id},
                               {QStringLiteral("code"), code},
                               {QStringLiteral("message"), text}});
  while (activity_.size() > 500)
    activity_.removeFirst();
  emit message(id, code, text);
}
} // namespace wp
