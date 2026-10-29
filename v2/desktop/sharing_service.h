#pragma once
#include "room_media.h"
#include "share_crypto.h"
#include "share_transport.h"
#include <QThreadPool>
namespace wp {
class SharingService;
class SharedFileSource final : public MediaSource {
  Q_OBJECT
public:
  SharedFileSource(SharingService &service, QString id);
  QList<TorrentFile> files() const override;
  bool selected(int index) const override;
  bool paused() const override;
  bool hasPiece(int piece) const override;
  void requestPiece(int piece, int deadlineMs) override;
  void cancelDeadline(int piece) override;
  void readPiece(int piece) override;
  int pieceLength() const override { return sharing::ChunkSize; }
  int pieceSize(int piece) const override;
  qint64 totalSize() const override;
  void readerOpened() override;
  void readerClosed() override;

private:
  SharingService &service_;
  QString id_;
};
class SharingService final : public QObject {
  Q_OBJECT
public:
  SharingService(LocalStore &store, RoomClient &rooms, RoomMedia &media, LibraryService &library,
                 TransferEngine &transfers, QObject *parent = nullptr);
  ~SharingService() override;
  QString prepare(const QString &path, const QString &room);
  void cancelPreparation(const QString &id);
  QString publishSubtitle(const QString &bundle, const QString &room, int index, int generation);
  QString subtitleFile(const QString &room, const QString &key);
  QString publish(const QString &bundle, const QString &room, const QList<int> &selected,
                  qint64 queueRevision = -1);
  MediaBinding binding(const QString &room, const QJsonObject &source, const QJsonObject &entry);
  QJsonArray downloads() const;
  void pause(const QString &id);
  void resume(const QString &id);
  void remove(const QString &id, bool deleteFile = false);
  void pin(const QString &id, bool pinned);
  void prepareMove(const QString &id);
  void reload(const QString &id);
  bool busy(const QString &id) const;
  bool offering(const QString &room, const QString &source) const;
  void setOffering(const QString &room, const QString &source, bool enabled);
  ShareTransport &transport() { return transport_; }
  QJsonObject bundle(const QString &id) const;
signals:
  void prepared(QJsonObject bundle);
  void preparationFinished(QString operation);
  void progress(QString operation, QString message);
  void changed();
  void problem(QString room, QString code, QString message);

private:
  friend class SharedFileSource;
  struct Demand {
    QString room, source, publisher;
    QJsonObject asset;
    bool wanted = false;
  };
  struct Job {
    QJsonObject row;
    std::unique_ptr<SharedFileSource> source;
    QHash<int, QByteArray> verified;
    QHash<int, int> priorities;
    QString operation, room, peer;
    int pending = -1, readers = 0;
    qint64 requested = 0, retry = 0;
    bool restoring = false, writing = false, verifying = false;
    qint64 bytesAt = 0, bytesLast = 0;
    qint64 verifiedBytes = 0;
    int rate = 0;
  };
  Job &job(const QString &id) const;
  Job &ensure(const Demand &demand);
  void tick();
  void reconcile();
  void received(const QString &room, const QString &peer, const QJsonObject &message);
  void serve(const QString &room, const QString &peer, const QJsonObject &request);
  void accept(Job &job, const QJsonObject &message);
  void restore(Job &job);
  void persist(Job &job, QJsonObject value);
  void failed(Job &job, const QString &message);
  bool owns(const QJsonObject &row) const;
  void complete(Job &job);
  void finishPublication(const QString &operation);
  void attachSubtitle(const QJsonObject &offer);
  LocalStore &store_;
  RoomClient &rooms_;
  RoomMedia &media_;
  LibraryService &library_;
  TransferEngine &transfers_;
  ShareTransport transport_;
  QTimer timer_;
  QThreadPool preparation_, disk_, seeding_;
  QHash<QString, std::shared_ptr<std::atomic_bool>> preparing_;
  QHash<QString, QString> preparationRooms_;
  std::map<QString, std::unique_ptr<Job>> jobs_;
  QHash<QString, QList<Demand>> demands_;
  QHash<QString, int> demandOrder_;
  QSet<QString> reusable_;
  QHash<QString, QString> identifying_;
  QSet<QString> serving_;
  struct Reply {
    QString room, peer, source;
    QJsonObject message;
    qint64 sent = 0;
    bool pending = true;
  };
  QHash<QString, Reply> replies_;
  QHash<QString, qint64> requests_;
  bool reconciling_ = false;
  qint64 reconciled_ = 0;
  mutable QHash<QString, QJsonObject> bundles_;
  mutable QHash<QString, QHash<int, QJsonObject>> bundleFiles_;
  mutable QHash<QString, QJsonObject> publisherBySha_;
  std::map<QString, std::unique_ptr<LocalFileSource>> publisherSources_;
  std::mutex treeMutex_;
  QHash<QString, std::shared_ptr<const sharing::MerkleTree>> trees_;
  QStringList treeOrder_;
  qint64 treeCost_ = 0;
  std::shared_ptr<const sharing::MerkleTree> treeFor(const QJsonObject &file);
  std::shared_ptr<std::atomic_bool> stopping_ = std::make_shared<std::atomic_bool>(false);
};
} // namespace wp
