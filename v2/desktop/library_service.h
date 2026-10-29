#pragma once
#include "local_store.h"
#include "media_source.h"
#include <QFutureWatcher>
#include <QThreadPool>
#include <QTimer>
#include <atomic>
#include <memory>

namespace wp {
struct ScanResult {
  QJsonArray files;
  QString error;
  int skipped = 0;
  bool cancelled = false;
};
class LibraryService final : public QObject {
  Q_OBJECT
public:
  explicit LibraryService(LocalStore &store, QObject *parent = nullptr);
  ~LibraryService() override;
  QString addRoot(const QString &path);
  void removeRoot(const QString &id);
  void scan(const QString &rootId);
  void cancel();
  void cancelScan();
  void cancel(const QString &operation);
  bool scanning() const { return scanning_; }
  QJsonArray roots() const;
  QJsonArray files(const QString &search = {}) const;
  QJsonObject match(const QString &sha256) const;
  QJsonObject file(const QString &id) const;
  void tag(const QString &id, const QJsonObject &fields);
  void refreshAvailability(const QString &root = {});
  // Hashing is also used for published files and completed torrent entries.
  QString identify(const QString &path);
  void registerIdentified(QJsonObject file);
  void registerIdentified(const QJsonArray &files);
  static bool unchanged(const QJsonObject &file);
signals:
  void changed();
  void progress(QString text);
  void identified(QString operationId, QJsonObject file);
  void failed(QString operationId, QString message);
  void cancelled(QString operationId);

private:
  LocalStore &store_;
  QThreadPool pool_;
  std::shared_ptr<std::atomic_bool> cancel_;
  QHash<QString, std::shared_ptr<std::atomic_bool>> jobs_;
  bool scanning_ = false;
};
// A fully identified external file remains read-only. It is never adopted as
// managed storage and never participates in automatic cleanup.
class LocalFileSource final : public MediaSource {
  Q_OBJECT
public:
  explicit LocalFileSource(QJsonObject file, QObject *parent = nullptr);
  QList<TorrentFile> files() const override;
  bool selected(int index) const override { return index == 0; }
  bool paused() const override { return false; }
  bool hasPiece(int piece) const override;
  void requestPiece(int, int) override {}
  void cancelDeadline(int) override {}
  void readPiece(int piece) override;
  int pieceLength() const override { return 1024 * 1024; }
  int pieceSize(int piece) const override;
  qint64 totalSize() const override;
  QJsonObject descriptor() const { return file_; }

private:
  QJsonObject file_;
};
} // namespace wp
