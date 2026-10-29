#pragma once
#include "media_source.h"
#include <QHash>
#include <QPointer>
#include <QSet>
#include <QTcpServer>
#include <QTcpSocket>
#include <QUrl>

namespace wp {
struct ByteRange {
  qint64 first = 0;
  qint64 last = -1;
  bool partial = false;
  bool valid = false;
};
ByteRange parseRange(const QByteArray &header, qint64 size);

// Loopback gateway reads libtorrent's verified piece cache, never sparse files.
class VerifiedStream final : public QObject {
  Q_OBJECT
public:
  explicit VerifiedStream(MediaSource &torrent, QObject *parent = nullptr);
  ~VerifiedStream() override;
  QUrl url(int fileIndex) const;
  qint64 servedBytes() const { return servedBytes_; }
  int activeRequests() const { return requests_.size(); }
  qint64 cacheBytes() const { return cacheBytes_; }
  QString diagnostics() const;
signals:
  void waiting(int piece);
  void failure(QString reason);

private:
  struct Request {
    QByteArray header;
    qint64 next = 0, end = -1;
    bool parsed = false;
    int fileIndex = -1;
    QSet<int> deadlines;
  };
  void accept();
  void parse(QTcpSocket *socket);
  void pump(QTcpSocket *socket);
  void release(QTcpSocket *socket);
  void reject(QTcpSocket *socket, int code, const QByteArray &message, qint64 size = -1);
  void received(int piece, const QByteArray &data, const QString &error);
  QPointer<MediaSource> torrent_;
  QTcpServer server_;
  QString token_;
  QHash<QTcpSocket *, Request> requests_;
  QHash<int, QByteArray> cache_;
  QList<int> cacheOrder_;
  QSet<int> pendingReads_;
  qint64 cacheBytes_ = 0, servedBytes_ = 0;
};
} // namespace wp
