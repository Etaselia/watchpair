#pragma once
#include <QByteArray>
#include <QList>
#include <QObject>
#include <QString>

namespace wp {
struct TorrentFile {
  int index;
  QString path;
  qint64 size;
  qint64 offset;
};
class MediaSource : public QObject {
  Q_OBJECT
public:
  using QObject::QObject;
  virtual QList<TorrentFile> files() const = 0;
  virtual bool selected(int index) const = 0;
  virtual bool paused() const = 0;
  virtual bool hasPiece(int piece) const = 0;
  virtual void requestPiece(int piece, int deadlineMs = 0) = 0;
  virtual void cancelDeadline(int piece) = 0;
  virtual void readPiece(int piece) = 0;
  virtual int pieceLength() const = 0;
  virtual int pieceSize(int piece) const = 0;
  virtual qint64 totalSize() const = 0;
  virtual void readerOpened() {}
  virtual void readerClosed() {}
signals:
  void manifestChanged();
  void stateChanged();
  void pieceAvailable(int piece);
  void pieceRead(int piece, QByteArray data, QString error);
  void activity(QString message);
};
} // namespace wp
