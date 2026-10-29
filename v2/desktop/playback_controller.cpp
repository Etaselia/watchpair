#include "playback_controller.h"
#include <QDateTime>
#include <algorithm>
#include <cmath>
namespace wp {
PlaybackController::PlaybackController(LocalStore &store, RoomClient &rooms, RoomMedia &media,
                                       TransferEngine &transfers, Player &player, QObject *parent)
    : QObject(parent), store_(store), rooms_(rooms), media_(media), transfers_(transfers), player_(player) {
  clock_.start();
  player_.setVolume(store_.setting(QStringLiteral("volume"), 80).toDouble());
  player_.setAudioDevice(store_.setting(QStringLiteral("audioDevice"), QStringLiteral("auto")).toString());
  player_.setSubtitleScale(store_.setting(QStringLiteral("subtitleScale"), 1).toDouble());
  connect(&rooms_, &RoomClient::connectionChanged, this, [this](const QString &room) {
    if (room == room_ && !local_ && !rooms_.connected(room)) {
      player_.setPaused(true);
      reason_ = rooms_.connectionState(room);
      emit changed();
    }
  });
  connect(&rooms_, &RoomClient::changed, this, &PlaybackController::enforceExplicitWatch);
  connect(&rooms_, &RoomClient::connectionChanged, this, &PlaybackController::enforceExplicitWatch);
  connect(&rooms_, &RoomClient::roomRemoved, this, [this](const QString &room) {
    leaving_.remove(room);
    if (watchRoom_ == room)
      watchRoom_.clear();
    if (room == room_) {
      room_.clear();
      if (!local_) {
        closeReader();
        reason_ = QStringLiteral("Choose a room");
      }
      emit changed();
    }
  });
  connect(&timer_, &QTimer::timeout, this, &PlaybackController::tick);
  start_.setSingleShot(true);
  start_.setTimerType(Qt::PreciseTimer);
  connect(&start_, &QTimer::timeout, this, &PlaybackController::tick);
  timer_.start(200);
}
PlaybackController::~PlaybackController() {
  timer_.stop();
  try {
    saveLocalResume();
  } catch (...) {
  }
  closeReader();
}
void PlaybackController::enforceExplicitWatch(const QString &room) {
  const auto member = rooms_.credential(room).value(QStringLiteral("memberId"));
  for (auto value : rooms_.room(room).value(QStringLiteral("members")).toArray()) {
    const auto m = value.toObject();
    if (m.value(QStringLiteral("id")) != member)
      continue;
    const auto state = m.value(QStringLiteral("watch")).toString();
    const bool watching = state == QStringLiteral("active") || state == QStringLiteral("staging");
    if (!watching)
      leaving_.remove(room);
    else if (watchRoom_ != room && rooms_.connected(room) && !leaving_.contains(room)) {
      leaving_.insert(room);
      rooms_.command(room, {{QStringLiteral("type"), QStringLiteral("watch.leave")}});
    }
    break;
  }
}
QJsonObject PlaybackController::self() const {
  if (room_.isEmpty())
    return {};
  const auto id = rooms_.credential(room_).value(QStringLiteral("memberId"));
  for (auto value : rooms_.room(room_).value(QStringLiteral("members")).toArray())
    if (value.toObject().value(QStringLiteral("id")) == id)
      return value.toObject();
  return {};
}
bool PlaybackController::joined() const {
  if (local_ || room_.isEmpty() || watchRoom_ != room_)
    return false;
  const auto watch = self().value(QStringLiteral("watch")).toString();
  return watch == QStringLiteral("active") || watch == QStringLiteral("staging");
}
void PlaybackController::setRoom(const QString &room) {
  if (room_ == room && !local_)
    return;
  leaveWatch();
  closeReader();
  preview_.reset();
  local_ = false;
  room_ = room;
  store_.setSetting(QStringLiteral("lastRoom"), room);
  reason_ = QStringLiteral("Join watch when you are ready");
  emit changed();
}
void PlaybackController::joinWatch() {
  if (room_.isEmpty())
    throw AppError(QStringLiteral("ROOM_MISSING"), QStringLiteral("Choose a room first."));
  if (local_) {
    saveLocalResume();
    closeReader();
    preview_.reset();
    local_ = false;
  }
  if (rooms_.room(room_)
          .value(QStringLiteral("playback"))
          .toObject()
          .value(QStringLiteral("entryId"))
          .isNull()) {
    for (auto value : rooms_.room(room_).value(QStringLiteral("entries")).toArray()) {
      const auto entry = value.toObject();
      if (entry.value(QStringLiteral("enabled")).toBool() &&
          !entry.value(QStringLiteral("watchedAt")).isDouble()) {
        rooms_.command(room_, {{QStringLiteral("type"), QStringLiteral("playback.choose")},
                               {QStringLiteral("entryId"), entry.value(QStringLiteral("id"))}});
        break;
      }
    }
  }
  watchRoom_ = room_;
  leaving_.remove(room_);
  rooms_.command(room_, {{QStringLiteral("type"), QStringLiteral("watch.join")}});
}
void PlaybackController::leaveWatch() {
  if (local_)
    saveLocalResume();
  else if (!room_.isEmpty() && rooms_.connected(room_) && joined())
    rooms_.command(room_, {{QStringLiteral("type"), QStringLiteral("watch.leave")}});
  watchRoom_.clear();
  closeReader();
}
void PlaybackController::choose(const QString &id) {
  if (local_) {
    saveLocalResume();
    closeReader();
    local_ = false;
    preview_.reset();
  }
  rooms_.command(
      room_, {{QStringLiteral("type"), QStringLiteral("playback.choose")}, {QStringLiteral("entryId"), id}});
}
void PlaybackController::togglePause() {
  if (local_) {
    if (player_.atEnd() && preview_) {
      const auto file = preview_->descriptor();
      playLocal(file);
      return;
    }
    localPaused_ = !localPaused_;
    player_.setPaused(localPaused_);
    saveLocalResume();
  } else
    rooms_.command(room_, {{QStringLiteral("type"), playRequested() ? QStringLiteral("playback.pause")
                                                                    : QStringLiteral("playback.play")}});
}
void PlaybackController::seek(double seconds) {
  seconds = std::clamp(seconds, 0.0, std::max(0.0, duration() - 0.05));
  if (local_)
    player_.seek(seconds);
  else
    rooms_.command(room_, {{QStringLiteral("type"), QStringLiteral("playback.seek")},
                           {QStringLiteral("position"), seconds}});
}
void PlaybackController::setRate(double value) {
  value = std::clamp(value, 0.25, 3.0);
  if (local_) {
    localRate_ = value;
    player_.setRate(value);
  } else
    rooms_.command(
        room_, {{QStringLiteral("type"), QStringLiteral("playback.rate")}, {QStringLiteral("rate"), value}});
}
void PlaybackController::setTracks(const QString &audio, const QString &subtitle, double delay) {
  if (local_) {
    localAudio_ = audio;
    localSubtitle_ = subtitle;
    localSubtitleDelay_ = delay;
    player_.setTracks(audio, subtitle, delay);
  } else
    rooms_.command(room_, {{QStringLiteral("type"), QStringLiteral("tracks.select")},
                           {QStringLiteral("audio"), audio},
                           {QStringLiteral("subtitle"), subtitle},
                           {QStringLiteral("subtitleDelay"), delay}});
}
void PlaybackController::closeReader() {
  start_.stop();
  scheduledStart_ = -1;
  player_.stop();
  stream_.reset();
  binding_ = {};
  entry_.clear();
  generation_ = -1;
  transfers_.setPlayback({}, -1);
}
void PlaybackController::load(const MediaBinding &binding, const QString &entry, int generation,
                              double target) {
  closeReader();
  binding_ = binding;
  entry_ = entry;
  generation_ = generation;
  endedGeneration_ = -1;
  target_ = target;
  seekIssued_ = false;
  stream_ = std::make_unique<VerifiedStream>(*binding.source);
  connect(stream_.get(), &VerifiedStream::failure, this, [this](const QString &message) {
    reason_ = message;
    emit error(QStringLiteral("MEDIA_READER"), message);
  });
  player_.open(stream_->url(binding.fileIndex), true);
  if (!binding.transferId.isEmpty() && transfers_.source(binding.transferId))
    transfers_.setPlayback(binding.transferId,
                           binding.transferIndex >= 0 ? binding.transferIndex : binding.fileIndex);
}
void PlaybackController::playLocal(const QJsonObject &file) {
  if (!LibraryService::unchanged(file))
    throw AppError(
        QStringLiteral("LOCAL_COPY_CHANGED"),
        QStringLiteral("This local copy changed or is missing. Rescan the library before playing it."));
  leaveWatch();
  preview_ = std::make_unique<LocalFileSource>(file);
  local_ = true;
  localPaused_ = false;
  localRate_ = 1;
  localAudio_ = QStringLiteral("auto");
  localSubtitle_ = QStringLiteral("off");
  localSubtitleDelay_ = 0;
  title_ = file.value(QStringLiteral("label")).toString();
  const auto identity = QStringLiteral("sha256:") + file.value(QStringLiteral("sha256")).toString();
  const double resume =
      store_.get(QStringLiteral("resume"), identity).value(QStringLiteral("position")).toDouble();
  load({preview_.get(),
        0,
        RoomMedia::mediaId(identity, 0),
        file.value(QStringLiteral("managedTransfer")).toString(),
        file.value(QStringLiteral("path")).toString(),
        {},
        file.value(QStringLiteral("managedIndex")).toInt(-1)},
       identity, 0, resume);
  emit changed();
}
void PlaybackController::retry() {
  if (local_ && preview_) {
    const auto file = preview_->descriptor();
    playLocal(file);
  } else {
    closeReader();
    if (!room_.isEmpty())
      media_.reconcile(room_);
  }
}
void PlaybackController::stop() {
  leaveWatch();
  closeReader();
  preview_.reset();
  local_ = false;
  title_.clear();
  reason_ = QStringLiteral("Playback stopped");
  emit changed();
}
bool PlaybackController::paused() const {
  return local_ ? localPaused_
                : room_.isEmpty() || rooms_.room(room_)
                                         .value(QStringLiteral("playback"))
                                         .toObject()
                                         .value(QStringLiteral("paused"))
                                         .toBool(true);
}
bool PlaybackController::playRequested() const {
  return local_ ? !localPaused_
                : !room_.isEmpty() && rooms_.room(room_)
                                          .value(QStringLiteral("playback"))
                                          .toObject()
                                          .value(QStringLiteral("requested"))
                                          .toBool();
}
double PlaybackController::position() const {
  return local_ ? player_.position() : room_.isEmpty() ? 0 : rooms_.timelinePosition(room_);
}
double PlaybackController::duration() const {
  if (local_)
    return player_.duration();
  if (room_.isEmpty())
    return 0;
  const auto p = rooms_.room(room_).value(QStringLiteral("playback")).toObject();
  return rooms_.entry(room_, p.value(QStringLiteral("entryId")).toString())
      .value(QStringLiteral("duration"))
      .toDouble(player_.duration());
}
double PlaybackController::rate() const {
  return local_            ? localRate_
         : room_.isEmpty() ? 1
                           : rooms_.room(room_)
                                 .value(QStringLiteral("playback"))
                                 .toObject()
                                 .value(QStringLiteral("rate"))
                                 .toDouble(1);
}
QString PlaybackController::audioChoice() const {
  return local_            ? localAudio_
         : room_.isEmpty() ? QStringLiteral("auto")
                           : rooms_.room(room_)
                                 .value(QStringLiteral("playback"))
                                 .toObject()
                                 .value(QStringLiteral("audio"))
                                 .toString(QStringLiteral("auto"));
}
QString PlaybackController::subtitleChoice() const {
  return local_            ? localSubtitle_
         : room_.isEmpty() ? QStringLiteral("off")
                           : rooms_.room(room_)
                                 .value(QStringLiteral("playback"))
                                 .toObject()
                                 .value(QStringLiteral("subtitle"))
                                 .toString(QStringLiteral("off"));
}
double PlaybackController::subtitleDelay() const {
  return local_            ? localSubtitleDelay_
         : room_.isEmpty() ? 0
                           : rooms_.room(room_)
                                 .value(QStringLiteral("playback"))
                                 .toObject()
                                 .value(QStringLiteral("subtitleDelay"))
                                 .toDouble();
}
void PlaybackController::saveLocalResume() {
  if (!local_ || !preview_ || !player_.loaded())
    return;
  const auto identity =
      QStringLiteral("sha256:") + preview_->descriptor().value(QStringLiteral("sha256")).toString();
  const auto position = player_.atEnd() ? 0 : player_.position();
  store_.put(QStringLiteral("resume"), identity,
             {{QStringLiteral("position"), position},
              {QStringLiteral("duration"), player_.duration()},
              {QStringLiteral("at"), QDateTime::currentMSecsSinceEpoch()}});
}
void PlaybackController::tick() {
  try {
    if (local_) {
      if (!preview_ || !preview_->hasPiece(0)) {
        reason_ = QStringLiteral("The local copy changed or became unavailable.");
        player_.setPaused(true);
        emit changed();
        return;
      }
      if (player_.loaded() && !seekIssued_) {
        if (std::abs(player_.position() - target_) > 0.1)
          player_.seek(std::min(target_, std::max(0.0, player_.duration() - 1)));
        seekIssued_ = true;
      }
      if (player_.atEnd())
        localPaused_ = true;
      player_.setPaused(localPaused_);
      player_.setRate(localRate_);
      if (player_.loaded())
        player_.setTracks(localAudio_, localSubtitle_, localSubtitleDelay_);
      reason_ = !player_.error().isEmpty() ? player_.error()
                : !player_.loaded()        ? QStringLiteral("Opening local media…")
                : player_.buffering()      ? QStringLiteral("Buffering local media…")
                                           : QString();
      if (clock_.elapsed() - lastResumeSave_ > 5000) {
        lastResumeSave_ = clock_.elapsed();
        saveLocalResume();
      }
      emit changed();
      return;
    }
    if (room_.isEmpty())
      return;
    if (!rooms_.connected(room_)) {
      player_.setPaused(true);
      reason_ = rooms_.connectionState(room_);
      emit changed();
      return;
    }
    const auto snapshot = rooms_.room(room_), p = snapshot.value(QStringLiteral("playback")).toObject();
    const auto id = p.value(QStringLiteral("entryId")).toString();
    if (!joined() || id.isEmpty()) {
      if (stream_)
        closeReader();
      reason_ = id.isEmpty() ? QStringLiteral("Choose an episode from the room queue")
                : self().value(QStringLiteral("watch")).toString() == QStringLiteral("excluded")
                    ? QStringLiteral("The host continued without you. Join watch when ready.")
                    : QStringLiteral("Join watch when you are ready");
      emit changed();
      return;
    }
    const auto entry = rooms_.entry(room_, id);
    title_ = entry.value(QStringLiteral("label")).toString();
    const auto binding = media_.binding(room_, id);
    const int generation = p.value(QStringLiteral("generation")).toInt();
    const double timeline = rooms_.timelinePosition(room_);
    if (!binding.source) {
      if (stream_)
        closeReader();
      reason_ = binding.reason;
    } else {
      if (!stream_ || binding.source != binding_.source || entry_ != id)
        load(binding, id, generation, timeline);
      if (generation_ != generation) {
        generation_ = generation;
        target_ = timeline;
        seekIssued_ = false;
        endedGeneration_ = -1;
        player_.setPaused(true);
      }
      if (player_.loaded() && !seekIssued_) {
        if (std::abs(player_.position() - target_) > 0.1) {
          player_.seek(target_);
          lastSeek_ = clock_.elapsed();
        }
        seekIssued_ = true;
      }
      const auto subtitle = p.value(QStringLiteral("subtitle")).toString();
      if (player_.loaded() && subtitle.startsWith(QStringLiteral("ext:")) && subtitleProvider_) {
        const auto path = subtitleProvider_(room_, subtitle);
        if (!path.isEmpty())
          player_.addSubtitle(QUrl::fromLocalFile(path), subtitle);
      }
      const bool tracks =
          player_.loaded() && player_.setTracks(p.value(QStringLiteral("audio")).toString(),
                                                p.value(QStringLiteral("subtitle")).toString(),
                                                p.value(QStringLiteral("subtitleDelay")).toDouble());
      drift_ = player_.position() - timeline;
      const bool starting = !p.value(QStringLiteral("paused")).toBool(true) &&
                            rooms_.serverNow(room_) < p.value(QStringLiteral("startsAt")).toDouble();
      const bool playing = !p.value(QStringLiteral("paused")).toBool(true) && !starting;
      if (starting) {
        const auto at = p.value(QStringLiteral("startsAt")).toDouble();
        if (at != scheduledStart_ || !start_.isActive()) {
          scheduledStart_ = at;
          start_.start(std::max(1, int(std::ceil(at - rooms_.serverNow(room_)))));
        }
      } else {
        start_.stop();
        scheduledStart_ = -1;
      }
      const bool needsBuffer = p.value(QStringLiteral("paused")).toBool(true) ||
                               self().value(QStringLiteral("watch")).toString() == QStringLiteral("staging");
      const bool buffered =
          !needsBuffer || !binding.path.isEmpty() ||
          player_.cachedSeconds() >= std::min(2.0, std::max(0.0, player_.duration() - timeline - 0.1));
      if (player_.loaded() && !player_.seeking() && std::abs(drift_) > 0.55 &&
          clock_.elapsed() - lastSeek_ > 1000) {
        player_.seek(timeline);
        lastSeek_ = clock_.elapsed();
      }
      const double baseRate = p.value(QStringLiteral("rate")).toDouble(1);
      player_.setRate(playing && std::abs(drift_) > 0.07 && std::abs(drift_) < 0.55
                          ? baseRate * (drift_ > 0 ? 0.98 : 1.02)
                          : baseRate);
      player_.setPaused(!playing || !tracks || !buffered || player_.atEnd());
      reason_ = !player_.error().isEmpty() ? player_.error()
                : !player_.loaded()
                    ? (binding.reason.isEmpty()
                           ? QStringLiteral("Opening verified media; downloading required container data…")
                           : binding.reason)
                : !tracks
                    ? QStringLiteral("The selected audio or subtitle track is unavailable on this device.")
                : player_.buffering() || !buffered
                    ? (binding.reason.isEmpty() ? QStringLiteral("Waiting for verified playback data…")
                                                : binding.reason)
                : player_.seeking() || std::abs(drift_) > 0.75
                    ? QStringLiteral("Synchronizing to the room position…")
                    : QString();
    }
    QJsonArray audio, subtitles;
    for (auto value : player_.tracks()) {
      const auto t = value.toObject();
      if (t.value(QStringLiteral("type")).toString() == QStringLiteral("audio"))
        audio.append(t.value(QStringLiteral("key")));
      else
        subtitles.append(t.value(QStringLiteral("key")));
    }
    const bool ready = binding.source && player_.loaded() && player_.error().isEmpty() &&
                       !player_.buffering() && !player_.seeking() &&
                       std::abs(player_.position() - timeline) <= 0.75 && rooms_.clockReady(room_) &&
                       reason_.isEmpty();
    rooms_.sendStatus(room_,
                      {{QStringLiteral("type"), QStringLiteral("status")},
                       {QStringLiteral("generation"), generation},
                       {QStringLiteral("entryId"), p.value(QStringLiteral("entryId"))},
                       {QStringLiteral("ready"), ready},
                       {QStringLiteral("reason"), reason_.left(300)},
                       {QStringLiteral("position"), std::max(0.0, player_.sampledPosition())},
                       {QStringLiteral("duration"), player_.duration() > 0 ? QJsonValue(player_.duration())
                                                                           : QJsonValue(QJsonValue::Null)},
                       {QStringLiteral("identity"), binding.source ? binding.identity : QString()},
                       {QStringLiteral("audio"), audio},
                       {QStringLiteral("subtitles"), subtitles},
                       {QStringLiteral("tracksKnown"), player_.loaded()}});
    if (ready && player_.atEnd() && !p.value(QStringLiteral("paused")).toBool(true) &&
        snapshot.value(QStringLiteral("reporterId")) == self().value(QStringLiteral("id")) &&
        timeline >= player_.duration() - 0.8 && endedGeneration_ != generation) {
      endedGeneration_ = generation;
      rooms_.command(room_, {{QStringLiteral("type"), QStringLiteral("playback.ended")}});
    }
    emit changed();
  } catch (const AppError &e) {
    player_.setPaused(true);
    reason_ = e.message();
    emit error(e.code(), e.message());
    emit changed();
  }
}
bool PlaybackController::usesPath(const QString &root) const {
  return !root.isEmpty() && binding_.source &&
         (binding_.path == root || binding_.path.startsWith(root + QLatin1Char('/')));
}
QJsonObject PlaybackController::diagnostics() const {
  return {{QStringLiteral("local"), local_},
          {QStringLiteral("generation"), generation_},
          {QStringLiteral("loaded"), player_.loaded()},
          {QStringLiteral("buffering"), player_.buffering()},
          {QStringLiteral("seeking"), player_.seeking()},
          {QStringLiteral("position"), player_.position()},
          {QStringLiteral("nativePosition"), player_.sampledPosition()},
          {QStringLiteral("duration"), player_.duration()},
          {QStringLiteral("drift"), drift_},
          {QStringLiteral("cachedSeconds"), player_.cachedSeconds()},
          {QStringLiteral("readerCacheBytes"), stream_ ? stream_->cacheBytes() : 0},
          {QStringLiteral("reason"), reason_}};
}
} // namespace wp
