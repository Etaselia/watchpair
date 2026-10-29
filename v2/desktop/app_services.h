#pragma once
#include "playback_controller.h"
#include "release_manager.h"
#include "sharing_service.h"
#include "storage_manager.h"
namespace wp {
class AppServices final : public QObject {
  Q_OBJECT
public:
  AppServices(const QString &profile, QObject *parent = nullptr, bool localOnly = false,
              bool headless = false);
  void restore();
  void shutdown();
  void perform(const std::function<void()> &action);
  void log(const QString &code, const QString &message, const QString &operation = {});
  QJsonArray activity() const { return activity_; }
  LocalStore store;
  TransferEngine transfers;
  LibraryService library;
  DirectDownloads direct;
  SourceResolver resolver;
  RoomClient rooms;
  RoomMedia media;
  SharingService sharing;
  Player player;
  PlaybackController playback;
  StorageManager storage;
  ReleaseManager releases;
signals:
  void issue(QString code, QString message);
  void activityChanged();

private:
  QJsonArray activity_;
  bool stopping_ = false;
};
} // namespace wp
