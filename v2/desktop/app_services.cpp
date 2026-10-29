#include "app_services.h"
#include <QDateTime>
#include <QEventLoop>
#include <QTimer>
namespace wp {
AppServices::AppServices(const QString &profile, QObject *parent, bool localOnly, bool headless)
    : QObject(parent), store(profile), transfers(store, nullptr, localOnly), library(store),
      direct(store, library, transfers), resolver(store), rooms(store),
      media(store, rooms, transfers, resolver, library, direct),
      sharing(store, rooms, media, library, transfers), player(nullptr, headless),
      playback(store, rooms, media, transfers, player), storage(*this), releases(store, transfers) {
  connect(&releases, &ReleaseManager::problem, this, [this](const QString &code, const QString &text) {
    log(code, text);
    emit issue(code, text);
  });
  connect(&storage, &StorageManager::problem, this, [this](const QString &code, const QString &text) {
    log(code, text);
    emit issue(code, text);
  });
  resolver.setBudget(transfers.downloadBudget());
  connect(&transfers, &TransferEngine::changed, &resolver, &SourceResolver::networkChanged);
  connect(&resolver, &SourceResolver::networkActivity, this,
          [this](int count) { transfers.setExternalTrafficFor(QStringLiteral("metadata"), count); });
  playback.setSubtitleProvider(
      [this](const QString &room, const QString &key) { return sharing.subtitleFile(room, key); });
  connect(&transfers, &TransferEngine::message, this,
          [this](const QString &, const QString &code, const QString &text) {
            log(code, text);
            if (code == QStringLiteral("TORRENT_ERROR") || code == QStringLiteral("STATE_SAVE_FAILED") ||
                code == QStringLiteral("MOVE_FAILED") || code == QStringLiteral("LISTEN_FAILED"))
              emit issue(code, text);
          });
  connect(&rooms, &RoomClient::error, this,
          [this](const QString &, const QString &code, const QString &text, const QString &operation) {
            log(code, text, operation);
            emit issue(code, text);
          });
  connect(&media, &RoomMedia::error, this, [this](const QString &, const QString &code, const QString &text) {
    if (code != QStringLiteral("CANCELLED")) {
      log(code, text);
      emit issue(code, text);
    }
  });
  connect(&library, &LibraryService::failed, this, [this](const QString &operation, const QString &text) {
    log(QStringLiteral("LIBRARY"), text, operation);
    emit issue(QStringLiteral("LIBRARY"), text);
  });
  connect(&direct, &DirectDownloads::failed, this, [this](const QString &operation, const QString &text) {
    log(QStringLiteral("DIRECT_DOWNLOAD"), text, operation);
    emit issue(QStringLiteral("DIRECT_DOWNLOAD"), text);
  });
  connect(&playback, &PlaybackController::error, this, [this](const QString &code, const QString &text) {
    log(code, text);
    emit issue(code, text);
  });
  connect(&player, &Player::activity, this,
          [this](const QString &text) { log(QStringLiteral("PLAYER"), text); });
  connect(&sharing, &SharingService::problem, this,
          [this](const QString &, const QString &code, const QString &text) {
            if (code != QStringLiteral("CANCELLED")) {
              log(code, text);
              emit issue(code, text);
            }
          });
}
void AppServices::restore() {
  transfers.restore();
  direct.restore();
  rooms.restore();
  storage.restore();
}
void AppServices::shutdown() {
  if (stopping_)
    return;
  stopping_ = true;
  perform([this] {
    playback.stop();
    rooms.shutdown();
    transfers.checkpoint();
  });
  QEventLoop pending;
  QTimer timeout, check;
  timeout.setSingleShot(true);
  connect(&timeout, &QTimer::timeout, &pending, &QEventLoop::quit);
  connect(&check, &QTimer::timeout, &pending, [&] {
    if (!transfers.pendingCheckpoints())
      pending.quit();
  });
  timeout.start(3000);
  check.start(25);
  if (transfers.pendingCheckpoints())
    pending.exec(QEventLoop::ExcludeUserInputEvents);
}
void AppServices::perform(const std::function<void()> &action) {
  try {
    action();
  } catch (const AppError &e) {
    log(e.code(), e.message());
    emit issue(e.code(), e.message());
  } catch (const std::exception &e) {
    const auto text = QString::fromUtf8(e.what());
    log(QStringLiteral("ACTION_FAILED"), text);
    emit issue(QStringLiteral("ACTION_FAILED"), text);
  }
}
void AppServices::log(const QString &code, const QString &text, const QString &operation) {
  if (!activity_.isEmpty()) {
    const auto last = activity_.last().toObject();
    if (last.value(QStringLiteral("code")).toString() == code &&
        last.value(QStringLiteral("message")).toString() == text &&
        QDateTime::currentMSecsSinceEpoch() - last.value(QStringLiteral("at")).toInteger() < 2000)
      return;
  }
  activity_.append(QJsonObject{{QStringLiteral("at"), QDateTime::currentMSecsSinceEpoch()},
                               {QStringLiteral("code"), code},
                               {QStringLiteral("message"), text},
                               {QStringLiteral("operation"), operation}});
  while (activity_.size() > 500)
    activity_.removeFirst();
  emit activityChanged();
}
} // namespace wp
