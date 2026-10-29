#include "verified_stream.h"
#include <QPointer>
#include <QTimer>
#include <QUuid>
#include <algorithm>
#include <limits>

namespace wp {
ByteRange parseRange(const QByteArray &header, qint64 size) {
  if (size <= 0)
    return {};
  if (header.isEmpty())
    return {0, size - 1, false, true};
  if (!header.startsWith("bytes=") || header.contains(','))
    return {};
  const auto pair = header.mid(6).split('-');
  if (pair.size() != 2)
    return {};
  bool ok1 = false, ok2 = false;
  auto first = pair[0].toLongLong(&ok1), last = pair[1].toLongLong(&ok2);
  auto digits = [](const QByteArray &x) {
    return !x.isEmpty() && std::all_of(x.begin(), x.end(), [](char c) { return c >= '0' && c <= '9'; });
  };
  if (pair[0].isEmpty()) {
    if (!ok2 || !digits(pair[1]) || last <= 0)
      return {};
    return {std::max(qint64(0), size - last), size - 1, true, true};
  }
  if (!ok1 || !digits(pair[0]) || first < 0 || first >= size)
    return {};
  if (pair[1].isEmpty())
    last = size - 1;
  else if (!ok2 || !digits(pair[1]) || last < first)
    return {};
  return {first, std::min(last, size - 1), true, true};
}
VerifiedStream::VerifiedStream(MediaSource &torrent, QObject *parent)
    : QObject(parent), torrent_(&torrent), token_(QUuid::createUuid().toString(QUuid::Id128)) {
  if (!server_.listen(QHostAddress::LocalHost, 0))
    throw std::runtime_error("Cannot bind the private media reader.");
  connect(&server_, &QTcpServer::newConnection, this, &VerifiedStream::accept);
  torrent.readerOpened();
  connect(&torrent, &MediaSource::pieceRead, this, &VerifiedStream::received);
  connect(&torrent, &MediaSource::pieceAvailable, this, [this](int) {
    for (auto *socket : requests_.keys())
      pump(socket);
  });
  connect(&torrent, &MediaSource::stateChanged, this, [this] {
    for (auto *socket : requests_.keys())
      pump(socket);
  });
  connect(&torrent, &QObject::destroyed, this, [this] {
    server_.close();
    for (auto *socket : requests_.keys()) {
      // Flush an already queued response header before ending the partial
      // body. Aborting it unseen makes HTTP clients retry a now-closed port.
      if (requests_.value(socket).parsed)
        socket->disconnectFromHost();
      else
        reject(socket, 410, "Source Removed");
    }
  });
}
QUrl VerifiedStream::url(int fileIndex) const {
  return QUrl(
      QStringLiteral("http://127.0.0.1:%1/media/%2/%3").arg(server_.serverPort()).arg(token_).arg(fileIndex));
}
VerifiedStream::~VerifiedStream() {
  if (torrent_)
    torrent_->readerClosed();
  server_.close();
  // Completed requests can still be children awaiting deleteLater(). Their
  // disconnected callbacks must not run after requests_ has been destroyed.
  for (auto *socket : server_.findChildren<QTcpSocket *>())
    disconnect(socket, nullptr, this, nullptr);
  for (auto *socket : requests_.keys()) {
    release(socket);
    socket->abort();
  }
}
QString VerifiedStream::diagnostics() const {
  if (!torrent_)
    return QStringLiteral("Media source was removed");
  QStringList out;
  for (auto it = requests_.cbegin(); it != requests_.cend(); ++it) {
    const auto &r = it.value();
    const int piece = torrent_->pieceLength() ? int(r.next / torrent_->pieceLength()) : -1;
    out.append(QStringLiteral("piece=%1 verified=%2 pending=%3 cached=%4 queued=%5")
                   .arg(piece)
                   .arg(torrent_->hasPiece(piece))
                   .arg(pendingReads_.contains(piece))
                   .arg(cache_.contains(piece))
                   .arg(it.key()->bytesToWrite()));
  }
  return out.join(QStringLiteral("; "));
}
void VerifiedStream::accept() {
  while (server_.hasPendingConnections()) {
    auto *socket = server_.nextPendingConnection();
    if (requests_.size() >= 8) {
      socket->disconnectFromHost();
      socket->deleteLater();
      continue;
    }
    requests_.insert(socket, {});
    socket->setReadBufferSize(8192);
    connect(socket, &QTcpSocket::readyRead, this, [this, socket] { parse(socket); });
    connect(socket, &QTcpSocket::bytesWritten, this, [this, socket](qint64) { pump(socket); });
    connect(socket, &QTcpSocket::disconnected, this, [this, socket] {
      release(socket);
      socket->deleteLater();
    });
    QPointer<QTcpSocket> safe(socket);
    QTimer::singleShot(5000, this, [this, safe] {
      if (safe && requests_.contains(safe) && !requests_[safe].parsed)
        reject(safe, 408, "Request Timeout");
    });
  }
}
void VerifiedStream::reject(QTcpSocket *socket, int code, const QByteArray &message, qint64 size) {
  QByteArray h = "HTTP/1.1 " + QByteArray::number(code) + ' ' + message +
                 "\r\nContent-Length: 0\r\nConnection: close\r\n";
  if (code == 416)
    h += "Content-Range: bytes */" + QByteArray::number(size) + "\r\n";
  socket->write(h + "\r\n");
  release(socket);
  socket->disconnectFromHost();
}
void VerifiedStream::parse(QTcpSocket *socket) {
  if (!torrent_) {
    socket->abort();
    return;
  }
  if (!requests_.contains(socket))
    return;
  auto &r = requests_[socket];
  if (r.parsed) {
    socket->readAll();
    return;
  }
  r.header += socket->readAll();
  if (r.header.size() >= 8192) {
    reject(socket, 431, "Request Header Fields Too Large");
    return;
  }
  if (!r.header.contains("\r\n\r\n"))
    return;
  const auto lines = r.header.split('\n');
  const auto first = lines.value(0).trimmed().split(' ');
  if (first.size() != 3 || (first[0] != "GET" && first[0] != "HEAD")) {
    reject(socket, 405, "Method Not Allowed");
    return;
  }
  const auto parts = first[1].split('?').first().split('/');
  if (parts.size() != 4 || parts[1] != "media" || parts[2] != token_.toUtf8()) {
    reject(socket, 403, "Forbidden");
    return;
  }
  bool ok = false;
  const int index = parts[3].toInt(&ok);
  const auto files = torrent_->files();
  auto file = std::find_if(files.begin(), files.end(), [index](const auto &f) { return f.index == index; });
  if (!ok || file == files.end()) {
    reject(socket, 404, "Not Found");
    return;
  }
  if (!torrent_->selected(index)) {
    reject(socket, 403, "File Not Selected");
    return;
  }
  QByteArray range;
  int rangeHeaders = 0;
  for (const auto &line : lines) {
    if (line.toLower().startsWith("range:")) {
      range = line.mid(6).trimmed();
      ++rangeHeaders;
    }
  }
  auto parsed = parseRange(range, file->size);
  if (!parsed.valid || rangeHeaders > 1) {
    reject(socket, 416, "Range Not Satisfiable", file->size);
    return;
  }
  r.parsed = true;
  r.fileIndex = index;
  r.next = file->offset + parsed.first;
  r.end = file->offset + parsed.last;
  QByteArray header = parsed.partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n";
  header += "Accept-Ranges: bytes\r\nContent-Type: application/octet-stream\r\nCache-Control: "
            "no-store\r\nConnection: close\r\nContent-Length: " +
            QByteArray::number(parsed.last - parsed.first + 1) + "\r\n";
  if (parsed.partial)
    header += "Content-Range: bytes " + QByteArray::number(parsed.first) + '-' +
              QByteArray::number(parsed.last) + '/' + QByteArray::number(file->size) + "\r\n";
  socket->write(header + "\r\n");
  if (first[0] == "HEAD") {
    release(socket);
    socket->disconnectFromHost();
    return;
  }
  pump(socket);
}
void VerifiedStream::pump(QTcpSocket *socket) {
  if (!torrent_) {
    socket->abort();
    return;
  }
  if (!requests_.contains(socket))
    return;
  auto &r = requests_[socket];
  if (!r.parsed || socket->state() != QAbstractSocket::ConnectedState)
    return;
  if (!torrent_->selected(r.fileIndex)) {
    socket->abort();
    return;
  }
  const auto length = torrent_->pieceLength();
  if (!length || length > 128 * 1024 * 1024) {
    emit failure(QStringLiteral("This source uses pieces larger than the 128 MiB streaming limit. Wait for "
                                "the complete episode, then play its verified local copy."));
    socket->abort();
    return;
  }
  while (r.next <= r.end && socket->bytesToWrite() < 128 * 1024) {
    const int piece = static_cast<int>(r.next / length);
    const int last = static_cast<int>(std::min(r.end, r.next + 4 * length - 1) / length);
    for (int want = piece; want <= last; ++want) {
      if (!r.deadlines.contains(want) && !torrent_->paused()) {
        r.deadlines.insert(want);
        torrent_->requestPiece(want, (want - piece) * 250);
      }
    }
    if (!torrent_->hasPiece(piece)) {
      emit waiting(piece);
      return;
    }
    if (!cache_.contains(piece)) {
      if (!pendingReads_.contains(piece)) {
        pendingReads_.insert(piece);
        torrent_->readPiece(piece);
      }
      return;
    }
    const auto &data = cache_[piece];
    const auto within = r.next % length;
    const auto count = std::min({qint64(data.size()) - within, r.end - r.next + 1, qint64(64 * 1024)});
    if (count <= 0) {
      emit failure(QStringLiteral("Invalid verified-piece read"));
      socket->abort();
      return;
    }
    const auto written = socket->write(data.constData() + within, count);
    if (written <= 0)
      return;
    r.next += written;
    servedBytes_ += written;
    if (r.next / length != piece) {
      r.deadlines.remove(piece);
      bool shared = false;
      for (auto it = requests_.cbegin(); it != requests_.cend(); ++it)
        shared |= it.value().deadlines.contains(piece);
      if (!shared)
        torrent_->cancelDeadline(piece);
    }
  }
  if (r.next > r.end) {
    release(socket);
    socket->disconnectFromHost();
  }
}
void VerifiedStream::release(QTcpSocket *socket) {
  if (!requests_.contains(socket))
    return;
  const auto deadlines = requests_.take(socket).deadlines;
  for (int piece : deadlines) {
    bool shared = false;
    for (auto it = requests_.cbegin(); it != requests_.cend(); ++it)
      shared |= it.value().deadlines.contains(piece);
    if (!shared && torrent_)
      torrent_->cancelDeadline(piece);
  }
}
void VerifiedStream::received(int piece, const QByteArray &data, const QString &error) {
  if (!pendingReads_.remove(piece))
    return;
  if (!error.isEmpty() || data.isEmpty()) {
    emit failure(error.isEmpty() ? QStringLiteral("Empty verified-piece read") : error);
    for (auto *socket : requests_.keys())
      socket->abort();
    return;
  }
  if (!cache_.contains(piece)) {
    while (!cacheOrder_.isEmpty() &&
           (cacheBytes_ + data.size() > 128 * 1024 * 1024 || cacheOrder_.size() >= 8)) {
      const auto old = cacheOrder_.takeFirst();
      cacheBytes_ -= cache_.take(old).size();
    }
    cache_.insert(piece, data);
    cacheOrder_.append(piece);
    cacheBytes_ += data.size();
  }
  for (auto *socket : requests_.keys())
    pump(socket);
}
} // namespace wp
