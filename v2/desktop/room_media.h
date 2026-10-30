#pragma once
#include "direct_download.h"
#include "library_service.h"
#include "room_client.h"
#include "source_resolver.h"
#include "transfer_engine.h"
#include <QPointer>
#include <QQueue>
#include <functional>
namespace wp {
struct MediaBinding {
  QPointer<MediaSource> source;
  int fileIndex = -1;
  QString identity, transferId, path, reason;
  int transferIndex = -1;
};
class RoomMedia final : public QObject {
  Q_OBJECT
public:
  RoomMedia(LocalStore &store, RoomClient &rooms, TransferEngine &transfers, SourceResolver &resolver,
            LibraryService &library, DirectDownloads &direct, QObject *parent = nullptr);
  ~RoomMedia() override;
  QString prepare(const QString &input, const QString &room = {}, const QString &root = {});
  QString publishTorrent(const QString &transferId, const QString &room, const QList<int> &selected,
                         bool downloadHere, bool followRoom, qint64 expectedQueueRevision = -1);
  QString publishDirect(const QString &downloadId, const QString &room);
  void requestDirectPublication(const QString &download, const QString &room);
  QString selectSource(const QString &room, const QString &source, const QStringList &mediaIds,
                       bool downloadHere, qint64 queueRevision);
  void setPolicy(const QString &room, const QString &policy);
  QString policy(const QString &room) const;
  void approve(const QString &room, const QString &sourceId, const QStringList &mediaIds);
  void refuse(const QString &room, const QString &sourceId);
  QJsonObject acquisition(const QString &room, const QString &sourceId) const;
  bool localCopyAvailable(const QJsonObject &entry) const;
  MediaBinding binding(const QString &room, const QString &entryId);
  void reconcile(const QString &room);
  void forgetRoom(const QString &room);
  static QString mediaId(const QString &identity, int fileIndex);
  using SharedBinding =
      std::function<MediaBinding(const QString &, const QJsonObject &, const QJsonObject &)>;
  void setSharedBinding(SharedBinding provider) { sharedBinding_ = std::move(provider); }
signals:
  void prepared(QJsonObject source);
  void changed(QString room);
  void error(QString room, QString code, QString message);

private:
  QString bindingKey(const QString &room, const QString &source) const;
  void resolved(const ResolvedSource &source);
  void ensureSource(const QString &room, const QJsonObject &source);
  void libraryChanged();
  void queueIdentification(const QString &transfer, int index);
  void pumpIdentification();
  void identify(const QString &transfer, int index, const QString &path);
  void publishFingerprints(const QString &room);
  void finishPublication(const QString &operationId, bool accepted);
  void resumePublications();
  void resumeDirectPublications();
  void removedAcquisition(const QString &field, const QString &id);
  LocalFileSource *localSource(const QJsonObject &file);
  bool validTorrentFile(const QString &transfer, const QJsonObject &source, const QJsonObject &entry) const;
  LocalStore &store_;
  RoomClient &rooms_;
  TransferEngine &transfers_;
  SourceResolver &resolver_;
  LibraryService &library_;
  DirectDownloads &direct_;
  QHash<QString, QJsonObject> resolving_, identifying_, publishing_;
  QSet<QString> sourceRequests_, hashing_, fingerprintRooms_;
  QQueue<QPair<QString, int>> identificationQueue_;
  QSet<QString> queuedIdentification_;
  QHash<QString, QString> preparingIdentification_;
  QHash<QString, QString> fingerprintOperations_;
  QHash<QString, QJsonObject> bySha_;
  QHash<QString, QJsonObject> identifiedFiles_;
  mutable QHash<QString, bool> identityCache_;
  QHash<QString, QHash<int, TorrentFile>> manifests_;
  std::map<QString, std::unique_ptr<LocalFileSource>> localSources_;
  bool reconciling_ = false;
  SharedBinding sharedBinding_;
};
} // namespace wp
