#pragma once
#include "media_source.h"
#include <QByteArray>
#include <QObject>
#include <QStringList>
#include <QTimer>
#include <libtorrent/session.hpp>
#include <libtorrent/torrent_handle.hpp>
#include <libtorrent/torrent_info.hpp>
#include <memory>

namespace wp {

// Owns the engine and original manifest indexes. UI state never schedules pieces.
class TorrentService final : public MediaSource {
  Q_OBJECT
public:
  explicit TorrentService(QString profile, QObject *parent = nullptr, bool localOnly = false);
  ~TorrentService() override;
  void add(const QString &source, const QString &directory, bool metadataOnly = true);
  void restore();
  void select(const QList<int> &indexes);
  void pause();
  void resume();
  void connectPeer(quint16 port);
  QList<TorrentFile> files() const;
  bool hasPiece(int piece) const;
  void requestPiece(int piece, int deadlineMs);
  void cancelDeadline(int piece);
  void readPiece(int piece);
  int pieceLength() const;
  int pieceSize(int piece) const;
  qint64 totalSize() const;
  quint16 port() const;
  double progress() const;
  int peers() const;
  bool paused() const { return manualPaused_; }
  QList<int> selection() const { return selected_; }
  bool selected(int index) const { return selected_.contains(index); }
  bool valid() const { return handle_.is_valid(); }
  QString error() const { return error_; }
  QString label() const;
  libtorrent::torrent_handle handle() const { return handle_; }
  void checkpoint();

private:
  void poll();
  void loadIntent();
  void saveIntent();
  libtorrent::session session_;
  libtorrent::torrent_handle handle_;
  QTimer timer_;
  QString profile_, source_, directory_, error_;
  QList<int> selected_;
  bool manualPaused_ = false;
  bool pendingResume_ = false;
};
} // namespace wp
