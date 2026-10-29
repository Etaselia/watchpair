#pragma once
#include "http_fetch.h"
#include "local_store.h"
#include "media_source.h"
#include <QHash>
#include <QSet>
#include <QTimer>
#include <libtorrent/session.hpp>
#include <libtorrent/torrent_handle.hpp>
#include <libtorrent/torrent_status.hpp>
#include <map>
#include <memory>

namespace wp {
struct TransferView {
  QString id, name, state, reason, path, identity, error;
  qint64 wanted = 0, verified = 0, downloaded = 0, uploaded = 0;
  int downRate = 0, upRate = 0, peers = 0, seeds = 0, order = 0;
  double availability = 0;
  bool manualPaused = false, metadata = false, pinned = false, moving = false;
  bool inUse = false;
};
class TransferEngine;
class TorrentTransfer final : public MediaSource {
  Q_OBJECT
public:
  TorrentTransfer(TransferEngine &engine, QString id);
  QString id() const { return id_; }
  QList<TorrentFile> files() const override;
  bool selected(int index) const override;
  bool paused() const override;
  bool hasPiece(int piece) const override;
  void requestPiece(int piece, int deadlineMs) override;
  void cancelDeadline(int piece) override;
  void readPiece(int piece) override;
  int pieceLength() const override;
  int pieceSize(int piece) const override;
  qint64 totalSize() const override;

private:
  TransferEngine &engine_;
  QString id_;
};
// The only libtorrent session in the application. Shared room demands never
// override local refusals, pauses, hard limits, or storage ownership.
class TransferEngine final : public QObject {
  Q_OBJECT
public:
  explicit TransferEngine(LocalStore &store, QObject *parent = nullptr, bool localOnly = false);
  ~TransferEngine() override;
  QString add(const QString &source, const QString &root = {});
  void restore();
  TorrentTransfer *source(const QString &id) const;
  QList<TransferView> transfers() const;
  TransferView view(const QString &id) const;
  QJsonObject intent(const QString &id) const;
  QList<qint64> fileProgress(const QString &id) const;
  QJsonArray trackers(const QString &id) const;
  QJsonArray peers(const QString &id) const;
  bool trackersReady(const QString &id) const;
  void select(const QString &id, const QHash<int, int> &priorities);
  void followRoomSelection(const QString &id);
  void overrideFiles(const QString &id, const QHash<int, int> &priorities);
  void setDemand(const QString &key, const QString &id, const QList<int> &files, const QString &policy,
                 bool approved);
  void removeDemand(const QString &key);
  void setPaused(const QString &id, bool paused);
  void setPinned(const QString &id, bool pinned);
  void setLimits(const QString &id, int downBytes, int upBytes, double ratio, int seedMinutes);
  void setOrder(const QStringList &ids);
  void setExternalWork(const QString &key, bool wanted, bool foreground = false);
  void forgetExternalWork(const QString &key);
  bool hasDownloadSlot(const QString &key) const;
  qint64 queueOrder(const QString &key) const;
  void moveQueue(const QString &key, int direction);
  void moveQueueGroup(const QStringList &keys, int direction);
  void setPlayback(const QString &id, int fileIndex);
  void recheck(const QString &id);
  void retry(const QString &id);
  void relocateMissing(const QString &id, const QString &root);
  void reannounce(const QString &id);
  void setTrackers(const QString &id, const QStringList &urls);
  void move(const QString &id, const QString &root);
  void remove(const QString &id, bool deleteFiles = false);
  void configure(const QJsonObject &settings);
  QJsonObject configuration() const;
  // Other acquisition transports share the same hard device cap. Reserving
  // bandwidth lowers libtorrent's allocation instead of multiplying the cap.
  void setExternalTraffic(int downloads, int uploads = 0);
  void setExternalTrafficFor(const QString &transport, int downloads, int uploads = 0);
  std::shared_ptr<HttpBudget> downloadBudget() const { return downBudget_; }
  std::shared_ptr<HttpBudget> uploadBudget() const { return upBudget_; }
  int externalDownLimit() const;
  int externalUpLimit() const;
  QJsonArray activity() const { return activity_; }
  void checkpoint();
  int pendingCheckpoints() const;
  quint16 port() const;
  bool localOnly() const { return localOnly_; }
  void connectPeer(const QString &id, const QString &address, quint16 port);
  QString magnet(const QString &id) const;
  bool matchesIdentity(const QString &id, const QString &identity) const;
  bool requestIdentifiedCopy(const QString &id, int fileIndex);
  void hold(const QString &id, const QString &token);
  void releaseHold(const QString &id, const QString &token);
  void reloadIntent(const QString &id);
  static bool video(const QString &path);
  static bool extra(const QString &path);
  static QString hashIdentity(const libtorrent::info_hash_t &hashes);
signals:
  void changed();
  void added(QString id);
  void removed(QString id);
  void manifestReady(QString id);
  void fileComplete(QString id, int fileIndex);
  void fileReadyForIdentification(QString id, int fileIndex, QString path);
  void identificationUnavailable(QString id, int fileIndex);
  void message(QString id, QString code, QString text);
  void detailsChanged(QString id);

private:
  friend class TorrentTransfer;
  struct Record {
    QJsonObject intent;
    libtorrent::torrent_handle handle;
    libtorrent::torrent_status status;
    std::unique_ptr<TorrentTransfer> source;
    QList<TorrentFile> files;
    QHash<int, int> priorities;
    QString reason, error;
    bool physicalPause = false, pendingResume = false, removing = false;
    int playbackFile = -1;
    QSet<int> pendingHashes;
    QSet<QString> holds;
    QList<qint64> progress;
    QJsonArray trackerRows, peerRows;
    qint64 detailsRequested = -10000;
    bool trackersLoaded = false;
  };
  Record &record(const QString &id) const;
  void install(QJsonObject intent, bool restoring);
  void manifest(Record &r);
  void applySelection(Record &r);
  void schedule();
  void ensureOrder(const QString &key);
  QSet<QString> downloadSlots() const;
  void requestDetails(const QString &id) const;
  void poll();
  void update();
  void persist(Record &r, QJsonObject value);
  void log(const QString &id, const QString &code, const QString &message);
  Record *byHandle(const libtorrent::torrent_handle &handle) const;
  QString ownedDirectory(const QString &root, const QString &id, const QString &nonce) const;
  bool owns(const QJsonObject &intent, const QString &path) const;
  void finishRemoval(Record &r);
  LocalStore &store_;
  std::unique_ptr<libtorrent::session> session_;
  std::map<QString, std::unique_ptr<Record>> records_;
  QTimer alerts_, updates_, checkpoints_;
  QJsonObject config_;
  QJsonArray activity_;
  bool localOnly_ = false, storageFailure_ = false;
  int externalDownloads_ = 0, externalUploads_ = 0;
  QHash<QString, QPair<int, int>> traffic_;
  std::shared_ptr<HttpBudget> downBudget_ = std::make_shared<HttpBudget>(),
                              upBudget_ = std::make_shared<HttpBudget>();
  bool configured_ = false;
  struct ExternalWork {
    bool wanted = false, foreground = false;
  };
  QHash<QString, ExternalWork> externalWork_;
  QHash<QString, qint64> orders_;
  qint64 orderSequence_ = 0;
};
} // namespace wp
