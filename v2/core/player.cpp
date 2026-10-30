#include "player.h"
#include <QByteArray>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QUrlQuery>
#include <algorithm>
#include <cmath>
#include <memory>
#include <stdexcept>
#include <vector>

namespace wp {
namespace {
QJsonValue node(const mpv_node &value, int depth = 0) {
  if (depth > 16)
    return {};
  switch (value.format) {
  case MPV_FORMAT_STRING:
    return QString::fromUtf8(value.u.string);
  case MPV_FORMAT_FLAG:
    return bool(value.u.flag);
  case MPV_FORMAT_INT64:
    return qint64(value.u.int64);
  case MPV_FORMAT_DOUBLE:
    return value.u.double_;
  case MPV_FORMAT_NODE_ARRAY: {
    QJsonArray result;
    for (int i = 0; i < std::min(2048, value.u.list->num); ++i)
      result.append(node(value.u.list->values[i], depth + 1));
    return result;
  }
  case MPV_FORMAT_NODE_MAP: {
    QJsonObject result;
    for (int i = 0; i < std::min(2048, value.u.list->num); ++i)
      result.insert(QString::fromUtf8(value.u.list->keys[i]), node(value.u.list->values[i], depth + 1));
    return result;
  }
  default:
    return {};
  }
}
} // namespace
Player::Player(QObject *parent, bool headless, bool silent) : QObject(parent), mpv_(mpv_create()) {
  renderReady_ = headless;
  clock_.start();
  if (!mpv_)
    throw std::runtime_error("Cannot create libmpv player");
  std::unique_ptr<mpv_handle, decltype(&mpv_terminate_destroy)> guard(mpv_, mpv_terminate_destroy);
  auto option = [this](const char *name, const char *value) {
    const auto code = mpv_set_option_string(mpv_, name, value);
    if (code < 0)
      throw std::runtime_error(std::string(name) + ": " + mpv_error_string(code));
  };
  option("config", "no");
  option("terminal", "no");
  option("input-default-bindings", "no");
  option("vo", headless ? "null" : "libmpv");
  // An omitted driver list enables mpv's system-output autodetection. "auto"
  // is an audio-device value, not the name of an audio output driver.
  if (headless || silent)
    option("ao", "null");
  // Validate original-media playback first. Native hardware interop is a
  // separate platform gate; do not silently select an unvalidated decoder.
  option("hwdec", "no");
  if (!headless)
    option("gpu-sw", "yes");
  option("cache", "yes");
  option("cache-secs", "5");
  option("demuxer-max-bytes", "64MiB");
  option("demuxer-max-back-bytes", "8MiB");
  option("network-timeout", "60");
  option("load-scripts", "no");
  option("keep-open", "yes");
  option("audio-channels", "auto-safe");
  option("target-prim", "bt.709");
  option("target-trc", "srgb");
  option("tone-mapping", "bt.2390");
  const auto code = mpv_initialize(mpv_);
  if (code < 0)
    throw std::runtime_error(mpv_error_string(code));
  mpv_observe_property(mpv_, 1, "time-pos", MPV_FORMAT_DOUBLE);
  mpv_observe_property(mpv_, 2, "duration", MPV_FORMAT_DOUBLE);
  mpv_observe_property(mpv_, 3, "paused-for-cache", MPV_FORMAT_FLAG);
  mpv_observe_property(mpv_, 4, "video-params/w", MPV_FORMAT_INT64);
  mpv_observe_property(mpv_, 5, "video-codec", MPV_FORMAT_STRING);
  mpv_observe_property(mpv_, 6, "pause", MPV_FORMAT_FLAG);
  mpv_observe_property(mpv_, 7, "seeking", MPV_FORMAT_FLAG);
  mpv_observe_property(mpv_, 8, "track-list", MPV_FORMAT_NODE);
  mpv_observe_property(mpv_, 9, "chapter-list", MPV_FORMAT_NODE);
  mpv_observe_property(mpv_, 10, "eof-reached", MPV_FORMAT_FLAG);
  mpv_observe_property(mpv_, 11, "demuxer-cache-duration", MPV_FORMAT_DOUBLE);
  mpv_observe_property(mpv_, 12, "volume", MPV_FORMAT_DOUBLE);
  mpv_observe_property(mpv_, 13, "playlist", MPV_FORMAT_NODE);
  mpv_observe_property(mpv_, 14, "audio-device-list", MPV_FORMAT_NODE);
  mpv_observe_property(mpv_, 15, "speed", MPV_FORMAT_DOUBLE);
  mpv_observe_property(mpv_, 16, "video-params", MPV_FORMAT_NODE);
  mpv_observe_property(mpv_, 17, "video-out-params", MPV_FORMAT_NODE);
  mpv_observe_property(mpv_, 18, "audio-params", MPV_FORMAT_NODE);
  mpv_observe_property(mpv_, 19, "aid", MPV_FORMAT_NODE);
  mpv_observe_property(mpv_, 20, "sid", MPV_FORMAT_NODE);
  const auto logLevel = qgetenv("WATCHPAIR_MPV_LOG_LEVEL");
  mpv_request_log_messages(mpv_, logLevel.isEmpty() ? "warn" : logLevel.constData());
  connect(&timer_, &QTimer::timeout, this, &Player::poll);
  timer_.setTimerType(Qt::PreciseTimer);
  timer_.start(20);
  guard.release();
}
Player::~Player() {
  timer_.stop();
  if (mpv_)
    mpv_terminate_destroy(mpv_);
}
void Player::command(const QList<QByteArray> &args) {
  std::vector<const char *> values;
  for (const auto &arg : args)
    values.push_back(arg.constData());
  values.push_back(nullptr);
  const auto code = mpv_command_async(mpv_, epoch_, values.data());
  if (code < 0) {
    error_ = QString::fromUtf8(mpv_error_string(code));
    emit activity(error_);
  }
}
void Player::open(const QUrl &url, bool startPaused) {
  ++epoch_;
  requested_ = url;
  // Give every private-reader open its own native playlist identity, including
  // rapid retries of the same episode. The reader ignores this query field.
  if (url.host() == QStringLiteral("127.0.0.1") && url.path().startsWith(QStringLiteral("/media/"))) {
    QUrlQuery query(url);
    query.addQueryItem(QStringLiteral("wp_epoch"), QString::number(epoch_));
    requested_.setQuery(query);
  }
  pendingLoaded_ = -1;
  nativePlaylist_ = {};
  playlistEpochs_.clear();
  pendingEndErrors_.clear();
  activePlaylist_ = -1;
  loaded_ = false;
  tracksKnown_ = false;
  pendingTracksRequest_ = 0;
  position_ = 0;
  duration_ = 0;
  cachedSeconds_ = 0;
  error_.clear();
  atEnd_ = false;
  buffering_ = false;
  seeking_ = false;
  tracks_ = {};
  chapters_ = {};
  mediaInfo_ = {};
  external_.clear();
  appliedAudio_.clear();
  appliedSubtitle_.clear();
  appliedDelay_ = 1e20;
  setPaused(startPaused);
  // Native numeric track IDs are local to a file. Start every new entry off;
  // the controller reapplies only that entry's resolved shared selection.
  command({"set", "sid", "no"});
  command({"set", "sub-delay", "0"});
  pendingOpen_ = !renderReady_;
  if (renderReady_)
    command({"loadfile", requested_.toEncoded(), "replace"});
}
void Player::rendererReady() {
  renderReady_ = true;
  if (pendingOpen_ && !requested_.isEmpty()) {
    pendingOpen_ = false;
    command({"loadfile", requested_.toEncoded(), "replace"});
  }
}
void Player::rendererFailed(const QString &message) {
  renderReady_ = false;
  pendingOpen_ = false;
  error_ = QStringLiteral("Video renderer: ") + message;
  emit activity(error_);
  emit changed();
}
void Player::setPaused(bool paused) {
  int value = paused ? 1 : 0;
  mpv_set_property_async(mpv_, epoch_, "pause", MPV_FORMAT_FLAG, &value);
}
void Player::seek(double seconds) {
  command({"seek", QByteArray::number(seconds, 'f', 3), "absolute+exact"});
}
void Player::stop() {
  ++epoch_;
  requested_.clear();
  pendingOpen_ = false;
  command({"stop"});
  loaded_ = false;
  tracksKnown_ = false;
  pendingTracksRequest_ = 0;
  position_ = 0;
  duration_ = 0;
  atEnd_ = false;
}
void Player::setRate(double rate) {
  rate = std::clamp(rate, 0.25, 3.1);
  if (std::abs(appliedRate_ - rate) < 0.0001)
    return;
  appliedRate_ = rate;
  command({"set", "speed", QByteArray::number(rate, 'f', 5)});
}
void Player::setVolume(double volume) {
  command({"set", "volume", QByteArray::number(std::clamp(volume, 0.0, 130.0), 'f', 1)});
}
void Player::setAudioDevice(const QString &device) {
  command({"set", "audio-device", device.toUtf8()});
}
void Player::setSubtitleScale(double scale) {
  command({"set", "sub-scale", QByteArray::number(std::clamp(scale, 0.5, 3.0), 'f', 2)});
}
void Player::addSubtitle(const QUrl &url, const QString &portableKey) {
  const auto path = url.isLocalFile() ? url.toLocalFile() : url.toString(QUrl::FullyEncoded);
  if (external_.value(path) == portableKey)
    return;
  external_.insert(path, portableKey);
  command({"sub-add", url.toEncoded(), "auto"});
}
QJsonArray Player::audioDevices() const {
  return devices_;
}
void Player::updatePlaylist() {
  for (auto value : nativePlaylist_) {
    const auto item = value.toObject();
    const auto id = item.value(QStringLiteral("id")).toInteger(-1);
    const auto path = item.value(QStringLiteral("filename")).toString();
    const bool match =
        QUrl::fromEncoded(path.toUtf8()) == requested_ ||
        (requested_.isLocalFile() && !QFileInfo(path).canonicalFilePath().isEmpty() &&
         QFileInfo(path).canonicalFilePath() == QFileInfo(requested_.toLocalFile()).canonicalFilePath());
    playlistEpochs_.insert(id, match ? epoch_ : 0);
    if (match && pendingEndErrors_.contains(id)) {
      error_ = pendingEndErrors_.take(id);
      emit activity(error_);
    }
  }
  if (pendingLoaded_ >= 0 && pendingLoaded_ == activePlaylist_ &&
      playlistEpochs_.value(activePlaylist_) == epoch_) {
    pendingLoaded_ = -1;
    loaded_ = true;
    error_.clear();
    // Do not block the GUI/render thread while mpv finishes native setup. A
    // distinct request ID ties the complete inventory to this validated open.
    pendingTracksRequest_ = (quint64(1) << 63) | epoch_;
    const auto code = mpv_get_property_async(mpv_, pendingTracksRequest_, "track-list", MPV_FORMAT_NODE);
    if (code < 0) {
      pendingTracksRequest_ = 0;
      error_ = QStringLiteral("Cannot read media tracks: ") + QString::fromUtf8(mpv_error_string(code));
      emit activity(error_);
    }
    emit activity(QStringLiteral("Native decoder opened media"));
  }
  if (pendingEndErrors_.size() > 32)
    pendingEndErrors_.clear();
}
void Player::readTracks(const QJsonArray &native, bool validated) {
  QJsonArray result;
  QHash<QString, int> ordinal;
  for (auto item : native) {
    const auto t = item.toObject();
    const auto type = t.value(QStringLiteral("type")).toString();
    if (type != QStringLiteral("audio") && type != QStringLiteral("sub"))
      continue;
    int index = t.value(QStringLiteral("ff-index")).toInt(ordinal.value(type));
    if (index < 0)
      index = ordinal.value(type);
    ordinal[type]++;
    auto key = type + QLatin1Char(':') + QString::number(index);
    auto filename = t.value(QStringLiteral("external-filename")).toString();
    const auto fileUrl = QUrl::fromEncoded(filename.toUtf8());
    if (fileUrl.isLocalFile())
      filename = fileUrl.toLocalFile();
    if (external_.contains(filename))
      key = external_.value(filename);
    result.append(QJsonObject{{QStringLiteral("key"), key},
                              {QStringLiteral("id"), t.value(QStringLiteral("id"))},
                              {QStringLiteral("type"), type},
                              {QStringLiteral("title"), t.value(QStringLiteral("title")).toString()},
                              {QStringLiteral("lang"), t.value(QStringLiteral("lang")).toString()},
                              {QStringLiteral("codec"), t.value(QStringLiteral("codec")).toString()},
                              {QStringLiteral("default"), t.value(QStringLiteral("default")).toBool()},
                              {QStringLiteral("external"), t.value(QStringLiteral("external")).toBool()},
                              {QStringLiteral("channels"), t.value(QStringLiteral("audio-channels"))}});
    if (result.size() >= 128)
      break;
  }
  tracks_ = result;
  if (validated)
    tracksKnown_ = loaded_;
}
bool Player::setTracks(const QString &audio, const QString &subtitle, double delay) {
  QString aid, sid = QStringLiteral("no");
  bool defaultChosen = false;
  for (auto value : tracks_) {
    const auto t = value.toObject();
    const auto id = QString::number(t.value(QStringLiteral("id")).toInt());
    if (t.value(QStringLiteral("type")).toString() == QStringLiteral("audio") &&
        (t.value(QStringLiteral("key")).toString() == audio ||
         (audio == QStringLiteral("auto") && aid.isEmpty())))
      aid = id;
    if (audio == QStringLiteral("auto") &&
        t.value(QStringLiteral("type")).toString() == QStringLiteral("audio") &&
        t.value(QStringLiteral("default")).toBool() && !defaultChosen) {
      aid = id;
      defaultChosen = true;
    }
    if (t.value(QStringLiteral("type")).toString() == QStringLiteral("sub") &&
        t.value(QStringLiteral("key")).toString() == subtitle)
      sid = id;
  }
  if ((audio != QStringLiteral("auto") && aid.isEmpty()) ||
      (subtitle != QStringLiteral("off") && sid == QStringLiteral("no")))
    return false;
  if (aid.isEmpty())
    aid = QStringLiteral("no");
  const bool changed =
      aid != appliedAudio_ || sid != appliedSubtitle_ || std::abs(delay - appliedDelay_) > 0.0001;
  const bool previouslyApplied = !appliedAudio_.isEmpty() || !appliedSubtitle_.isEmpty();
  if (aid != appliedAudio_) {
    command({"set", "aid", aid.toUtf8()});
    appliedAudio_ = aid;
  }
  if (sid != appliedSubtitle_) {
    command({"set", "sid", sid.toUtf8()});
    appliedSubtitle_ = sid;
  }
  if (std::abs(delay - appliedDelay_) > 0.0001) {
    command({"set", "sub-delay", QByteArray::number(std::clamp(delay, -600.0, 600.0), 'f', 3)});
    appliedDelay_ = delay;
  }
  // A paused, fully cached Matroska file can keep its old frame after mpv's
  // internal subtitle refresh seeks behind the current position. Queue an
  // exact refresh after the track commands so the chosen subtitle/delay is
  // visible immediately, without briefly resuming shared playback.
  if (changed && previouslyApplied && loaded_ && paused_)
    seek(position_);
  return true;
}
double Player::position() const {
  // Property notifications carry sampled PTS. Project only their short polling
  // age; never extrapolate through an underrun or a stopped decoder.
  const double advance =
      loaded_ && !paused_ && !seeking_ && !buffering_ && !atEnd_
          ? std::clamp<qint64>(clock_.elapsed() - positionAt_, 0, 100) * observedRate_ / 1000.0
          : 0;
  return duration_ > 0 ? std::min(duration_, position_ + advance) : position_ + advance;
}
void Player::poll() {
  bool dirty = false;
  for (;;) {
    auto *e = mpv_wait_event(mpv_, 0);
    if (e->event_id == MPV_EVENT_NONE)
      break;
    if (e->event_id == MPV_EVENT_LOG_MESSAGE) {
      const auto *log = static_cast<mpv_event_log_message *>(e->data);
      auto message = QString::fromUtf8(log->text).trimmed();
      message.replace(QRegularExpression(QStringLiteral("http://127\\.0\\.0\\.1:[0-9]+/media/[^ /]+/")),
                      QStringLiteral("[private media reader]/"));
      emit activity(message);
    }
    if (e->event_id == MPV_EVENT_START_FILE) {
      activePlaylist_ = static_cast<mpv_event_start_file *>(e->data)->playlist_entry_id;
      updatePlaylist();
      dirty = true;
    }
    if (e->event_id == MPV_EVENT_FILE_LOADED) {
      pendingLoaded_ = activePlaylist_;
      updatePlaylist();
      dirty = true;
    } else if (e->event_id == MPV_EVENT_END_FILE) {
      auto *end = static_cast<mpv_event_end_file *>(e->data);
      if (end->reason == MPV_END_FILE_REASON_ERROR &&
          playlistEpochs_.value(end->playlist_entry_id) == epoch_ && !requested_.isEmpty()) {
        error_ = QString::fromUtf8(mpv_error_string(end->error));
        emit activity(error_);
        dirty = true;
      } else if (end->reason == MPV_END_FILE_REASON_ERROR && !requested_.isEmpty())
        pendingEndErrors_.insert(end->playlist_entry_id, QString::fromUtf8(mpv_error_string(end->error)));
      playlistEpochs_.remove(end->playlist_entry_id);
    } else if ((e->event_id == MPV_EVENT_COMMAND_REPLY || e->event_id == MPV_EVENT_SET_PROPERTY_REPLY) &&
               e->error < 0 && e->reply_userdata == epoch_) {
      error_ = QString::fromUtf8(mpv_error_string(e->error));
      emit activity(error_);
    } else if (e->event_id == MPV_EVENT_GET_PROPERTY_REPLY && pendingTracksRequest_ &&
               e->reply_userdata == pendingTracksRequest_) {
      const auto *property = static_cast<mpv_event_property *>(e->data);
      const bool current = pendingTracksRequest_ == ((quint64(1) << 63) | epoch_) && loaded_ &&
                           playlistEpochs_.value(activePlaylist_) == epoch_;
      pendingTracksRequest_ = 0;
      if (!current)
        continue;
      if (e->error >= 0 && property && property->name &&
          QString::fromUtf8(property->name) == QStringLiteral("track-list") &&
          property->format == MPV_FORMAT_NODE && property->data &&
          static_cast<mpv_node *>(property->data)->format == MPV_FORMAT_NODE_ARRAY) {
        readTracks(node(*static_cast<mpv_node *>(property->data)).toArray(), true);
      } else {
        error_ = QStringLiteral("Cannot read media tracks: ") +
                 (e->error < 0 ? QString::fromUtf8(mpv_error_string(e->error))
                               : QStringLiteral("invalid native inventory"));
        emit activity(error_);
      }
      dirty = true;
    } else if (e->event_id == MPV_EVENT_PROPERTY_CHANGE) {
      auto *p = static_cast<mpv_event_property *>(e->data);
      if (!p->data)
        continue;
      dirty = true;
      if (e->reply_userdata == 1) {
        position_ = *static_cast<double *>(p->data);
        positionAt_ = clock_.elapsed();
      } else if (e->reply_userdata == 2)
        duration_ = *static_cast<double *>(p->data);
      else if (e->reply_userdata == 3)
        buffering_ = *static_cast<int *>(p->data) != 0;
      else if (e->reply_userdata == 4)
        emit activity(QStringLiteral("Video width: %1").arg(*static_cast<int64_t *>(p->data)));
      else if (e->reply_userdata == 5)
        emit activity(QStringLiteral("Video codec: ") + QString::fromUtf8(*static_cast<char **>(p->data)));
      else if (e->reply_userdata == 6) {
        const bool next = *static_cast<int *>(p->data) != 0;
        if (paused_ != next)
          positionAt_ = clock_.elapsed();
        paused_ = next;
      } else if (e->reply_userdata == 7)
        seeking_ = *static_cast<int *>(p->data) != 0;
      else if (e->reply_userdata == 8)
        readTracks(node(*static_cast<mpv_node *>(p->data)).toArray());
      else if (e->reply_userdata == 9)
        chapters_ = node(*static_cast<mpv_node *>(p->data)).toArray();
      else if (e->reply_userdata == 10) {
        const bool end = *static_cast<int *>(p->data) != 0;
        if (end && loaded_ && !atEnd_) {
          atEnd_ = true;
          emit ended();
        } else if (!end)
          atEnd_ = false;
      } else if (e->reply_userdata == 11)
        cachedSeconds_ = *static_cast<double *>(p->data);
      else if (e->reply_userdata == 12)
        volume_ = *static_cast<double *>(p->data);
      else if (e->reply_userdata == 13) {
        nativePlaylist_ = node(*static_cast<mpv_node *>(p->data)).toArray();
        updatePlaylist();
      } else if (e->reply_userdata == 14)
        devices_ = node(*static_cast<mpv_node *>(p->data)).toArray();
      else if (e->reply_userdata == 15)
        observedRate_ = *static_cast<double *>(p->data);
      else if (e->reply_userdata >= 16 && e->reply_userdata <= 20) {
        const char *names[] = {"video", "videoOutput", "audio", "audioId", "subtitleId"};
        mediaInfo_.insert(QString::fromLatin1(names[e->reply_userdata - 16]),
                          node(*static_cast<mpv_node *>(p->data)));
      }
    }
  }
  if (dirty)
    emit changed();
}
} // namespace wp
