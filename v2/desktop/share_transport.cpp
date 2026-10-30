#include "share_transport.h"
#include "share_crypto.h"
#include <QDateTime>
#include <QFutureWatcher>
#include <QJsonDocument>
#include <QNetworkProxy>
#include <QtConcurrent>
#include <QtEndian>
#include <openssl/crypto.h>
namespace wp {
namespace {
QString id(const QString &room, const QString &peer) {
  return room + QLatin1Char(':') + peer;
}
qint64 now() {
  return QDateTime::currentMSecsSinceEpoch();
}
QByteArray frame(const QByteArray &data) {
  QByteArray out(4, Qt::Uninitialized);
  qToBigEndian(quint32(data.size()), out.data());
  out += data;
  return out;
}
QByteArray encode(const QJsonObject &value) {
  return QJsonDocument(value).toJson(QJsonDocument::Compact);
}
} // namespace
ShareTransport::ShareTransport(LocalStore &store, RoomClient &rooms, TransferEngine &transfers,
                               QObject *parent)
    : QObject(parent), store_(store), rooms_(rooms), transfers_(transfers) {
  privateKey_ =
      QByteArray::fromBase64(store_.setting(QStringLiteral("sharePrivateKey")).toString().toLatin1());
  if (privateKey_.isEmpty()) {
    privateKey_ = sharing::random(32);
    store_.setSetting(QStringLiteral("sharePrivateKey"), QString::fromLatin1(privateKey_.toBase64()));
  }
  publicKey_ = sharing::publicKey(privateKey_);
  receives_.setMaxThreadCount(32);
  uploads_.setMaxThreadCount(8);
  connect(&listener_, &QTcpServer::newConnection, this, [this] {
    while (listener_.hasPendingConnections())
      incoming(listener_.nextPendingConnection());
  });
  connect(&rooms_, &RoomClient::ticketReady, this, &ShareTransport::ticket);
  connect(&transfers_, &TransferEngine::changed, this, [this] {
    if (transfers_.configuration() != config_)
      network();
  });
  connect(&rooms_, &RoomClient::changed, this, [this](const QString &room) {
    QHash<QString, QByteArray> allowed;
    for (auto value : rooms_.room(room).value(QStringLiteral("members")).toArray()) {
      const auto m = value.toObject();
      if (m.value(QStringLiteral("connected")).toBool())
        allowed.insert(m.value(QStringLiteral("id")).toString(),
                       QByteArray::fromBase64(m.value(QStringLiteral("publicKey")).toString().toLatin1()));
    }
    for (auto &[_, p] : peers_)
      if (p->room == room && (allowed.value(p->id).size() != 32 ||
                              sharing::deriveKey(privateKey_, allowed.value(p->id), p->context) != p->key))
        close(*p);
  });
  connect(&rooms_, &RoomClient::operationComplete, this,
          [this](const QString &, const QString &op) { keyPending_.remove(op); });
  connect(&rooms_, &RoomClient::error, this,
          [this](const QString &, const QString &, const QString &, const QString &op) {
            keyPending_.remove(op);
          });
  connect(&rooms_, &RoomClient::roomRemoved, this, [this](const QString &room) {
    for (auto it = peers_.begin(); it != peers_.end();)
      if (it->second->room == room) {
        close(*it->second);
        it = peers_.erase(it);
      } else
        ++it;
  });
  connect(&timer_, &QTimer::timeout, this, &ShareTransport::tick);
  timer_.start(1000);
  connect(&pump_, &QTimer::timeout, this, [this] {
    for (auto &[_, p] : peers_)
      if (p->socket && p->socket->state() == QAbstractSocket::ConnectedState) {
        bytes(*p);
        if (!p->output.isEmpty() && p->socket->bytesToWrite() < 65536) {
          const auto n = transfers_.uploadBudget()->take(std::min<qint64>(262144, p->output.size()));
          if (n > 0) {
            const auto sent = p->socket->write(p->output.constData(), n);
            if (sent > 0)
              p->output.remove(0, sent);
          }
        }
        if (p->output.isEmpty() && p->authenticated && !p->queue.isEmpty())
          p->output = frame(p->queue.dequeue().bytes);
      }
  });
  pump_.start(10);
  network();
}
ShareTransport::~ShareTransport() {
  timer_.stop();
  pump_.stop();
  listener_.close();
  for (auto &[_, p] : peers_)
    close(*p);
  receives_.waitForDone();
  uploads_.waitForDone();
  OPENSSL_cleanse(privateKey_.data(), privateKey_.size());
}
void ShareTransport::setActive(int downloads, int uploads) {
  downloads_ = downloads;
  uploadsCount_ = uploads;
  for (const auto &[_, p] : peers_) {
    // Idle long-polls carry no media. Acquisitions are counted by the service.
    if (p->upload || !p->output.isEmpty() || !p->queue.isEmpty() ||
        (p->socket && p->socket->bytesToWrite() > 0))
      ++uploads;
  }
  transfers_.setExternalTrafficFor(QStringLiteral("sharing"), downloads, uploads);
}
void ShareTransport::network() {
  auto next = transfers_.configuration();
  QJsonObject old = config_;
  config_ = next;
  for (const auto &key : {QStringLiteral("bind"), QStringLiteral("proxyHost"), QStringLiteral("proxyPort"),
                          QStringLiteral("offline"), QStringLiteral("sharingMode")})
    if (old.value(key) != next.value(key)) {
      for (auto &[_, p] : peers_) {
        close(*p);
        p->expires = 0;
      }
      listener_.close();
      break;
    }
  if (next.value(QStringLiteral("offline")).toBool() ||
      !next.value(QStringLiteral("proxyHost")).toString().isEmpty()) {
    listener_.close();
    return;
  }
  if (!listener_.isListening()) {
    const auto bind = next.value(QStringLiteral("bind")).toString();
    QHostAddress address = bind.isEmpty() ? QHostAddress(transfers_.localOnly() ? QHostAddress::LocalHost
                                                                                : QHostAddress::AnyIPv4)
                                          : QHostAddress(bind);
    if (!listener_.listen(address, 0))
      emit problem(
          {}, relayAllowed() ? QStringLiteral("The direct listener could not bind; relay fallback is available.")
                              : QStringLiteral("The direct listener could not bind; relay is disabled."));
  }
}
ShareTransport::Peer &ShareTransport::peer(const QString &room, const QString &peerId) {
  const auto key = id(room, peerId);
  auto it = peers_.find(key);
  if (it != peers_.end())
    return *it->second;
  auto p = std::make_unique<Peer>();
  p->room = room;
  p->id = peerId;
  p->self = rooms_.credential(room).value(QStringLiteral("memberId")).toString();
  p->context =
      sharing::context(rooms_.credential(room).value(QStringLiteral("roomId")).toString(), p->self, peerId);
  const auto snapshot = rooms_.room(room);
  for (auto value : snapshot.value(QStringLiteral("members")).toArray())
    if (value.toObject().value(QStringLiteral("id")).toString() == peerId) {
      const auto pub =
          QByteArray::fromBase64(value.toObject().value(QStringLiteral("publicKey")).toString().toLatin1());
      p->key = sharing::deriveKey(privateKey_, pub, p->context);
      break;
    }
  if (p->key.isEmpty())
    throw AppError(QStringLiteral("PEER_KEY"),
                   QStringLiteral("The peer's private sharing key is not ready."));
  auto *raw = p.get();
  peers_.emplace(key, std::move(p));
  return *raw;
}
void ShareTransport::close(Peer &p) {
  if (p.receive)
    p.receive->cancelled.store(true);
  if (p.upload)
    p.upload->cancelled.store(true);
  p.receive.reset();
  p.upload.reset();
  if (p.candidate) {
    p.candidate->abort();
    p.candidate->deleteLater();
    p.candidate = nullptr;
  }
  p.candidateInput.clear();
  if (p.socket) {
    disconnect(p.socket, nullptr, this, nullptr);
    p.socket->abort();
    p.socket->deleteLater();
    p.socket = nullptr;
  }
  p.authenticated = false;
  p.connecting = false;
  p.input.clear();
  p.output.clear();
  p.queue.clear();
  p.uploadFrame = {};
  p.state.clear();
  p.directStarted = 0;
  p.directFailed = false;
  p.relayActive = false;
  p.retry = 0;
  p.directRetry = 0;
}
void ShareTransport::fail(Peer &p, const QString &message) {
  if (promoteCandidate(p))
    return;
  close(p);
  p.retry = now() + 3000;
  p.directRetry = now() + 30000;
  p.directStarted = now();
  p.directFailed = true;
  p.state = relayAllowed() ? message : QStringLiteral("Direct connection unavailable · relay disabled");
  emit changed();
}
void ShareTransport::tick() {
  try {
    network();
    if (config_.value(QStringLiteral("offline")).toBool())
      return;
    QSet<QString> wanted;
    for (auto row : rooms_.rooms()) {
      const auto room = row.toObject().value(QStringLiteral("key")).toString();
      if (!rooms_.connected(room))
        continue;
      const auto snapshot = rooms_.room(room), cred = rooms_.credential(room);
      const auto self = cred.value(QStringLiteral("memberId")).toString();
      bool keyReady = false;
      for (auto value : snapshot.value(QStringLiteral("members")).toArray())
        if (value.toObject().value(QStringLiteral("id")).toString() == self)
          keyReady = value.toObject().value(QStringLiteral("publicKey")).toString() ==
                     QString::fromLatin1(publicKey_.toBase64());
      if (!keyReady) {
        bool pending = false;
        for (auto value : store_.find(QStringLiteral("room-command"), QStringLiteral("room"), room))
          if (value.toObject().value(QStringLiteral("state")).toString() == QStringLiteral("pending") &&
              value.toObject()
                      .value(QStringLiteral("envelope"))
                      .toObject()
                      .value(QStringLiteral("command"))
                      .toObject()
                      .value(QStringLiteral("type"))
                      .toString() == QStringLiteral("member.key"))
            pending = true;
        if (!pending)
          keyPending_.insert(rooms_.command(
              room, {{QStringLiteral("type"), QStringLiteral("member.key")},
                     {QStringLiteral("publicKey"), QString::fromLatin1(publicKey_.toBase64())}}));
        continue;
      }
      QSet<QString> publishers;
      for (auto value : snapshot.value(QStringLiteral("sources")).toArray())
        if (value.toObject().value(QStringLiteral("kind")).toString() == QStringLiteral("share"))
          publishers.insert(value.toObject().value(QStringLiteral("publisherId")).toString());
      for (auto value : snapshot.value(QStringLiteral("members")).toArray()) {
        const auto member = value.toObject();
        const auto other = member.value(QStringLiteral("id")).toString();
        if ((!publishers.contains(self) && !publishers.contains(other)) || other == self ||
            !member.value(QStringLiteral("connected")).toBool() ||
            member.value(QStringLiteral("publicKey")).toString().isEmpty())
          continue;
        wanted.insert(id(room, other));
        auto &p = peer(room, other);
        const auto expected = sharing::deriveKey(
            privateKey_,
            QByteArray::fromBase64(member.value(QStringLiteral("publicKey")).toString().toLatin1()),
            p.context);
        if (expected != p.key) {
          close(p);
          p.key = expected;
          p.expires = 0;
        }
        if (!p.ticketPending && now() - p.requested > 2000 &&
            (p.expires < now() + 30000 || (!p.socket && p.relay.isEmpty()))) {
          p.ticketPending = true;
          p.requested = now();
          rooms_.transferTicket(room, other, port());
        }
        if (p.ticketPending && now() - p.requested > 20000)
          p.ticketPending = false;
        if (now() < p.retry)
          continue;
        if (!p.directStarted && (!p.endpoint.isEmpty() || p.expires > now())) {
          p.directStarted = now();
          p.state = QStringLiteral("Trying direct peer-to-peer connection…");
        }
        if (!p.authenticated && !p.socket && !listener_.isListening() && p.directStarted) {
          // A configured proxy forbids a direct connection outside the proxy.
          p.directFailed = true;
          p.state = relayAllowed() ? QStringLiteral("Direct unavailable; connecting to encrypted relay…")
                                  : QStringLiteral("Direct connection unavailable · relay disabled");
        }
        if (p.directStarted && !p.socket && !p.connecting && now() > p.directRetry && listener_.isListening()) {
          const auto endpoint = p.endpoint.isEmpty() ? member.value(QStringLiteral("endpoint")).toObject()
                                                     : p.endpoint;
          QHostAddress address(endpoint.value(QStringLiteral("address")).toString());
          const int port = endpoint.value(QStringLiteral("port")).toInt();
          if (!address.isNull() && !address.isMulticast() && port > 0 && port <= 65535) {
            auto *socket = new QTcpSocket(this);
            socket->setProxy(QNetworkProxy::NoProxy);
            const auto bind = config_.value(QStringLiteral("bind")).toString();
            if (!bind.isEmpty() && !socket->bind(QHostAddress(bind), 0)) {
              socket->deleteLater();
              fail(p, QStringLiteral("Direct bind failed; connecting to encrypted relay…"));
            } else {
              p.directStarted = now();
              p.directFailed = false;
              ++p.directAttempts;
              p.state = QStringLiteral("Trying direct peer-to-peer connection…");
              attach(p, socket, true);
              socket->connectToHost(address, quint16(port));
              QTimer::singleShot(2500, socket, [this, socket, key = id(room, other)] {
                auto it = peers_.find(key);
                if (it != peers_.end() && it->second->socket == socket && !it->second->authenticated)
                  fail(*it->second, QStringLiteral("Connecting through encrypted relay…"));
              });
            }
          }
        }
        // A missing/invalid advertised endpoint is an explicit direct-route
        // failure. A pending socket must finish its own bounded attempt.
        if (!p.authenticated && !p.socket && p.directStarted && !p.directFailed &&
            now() - p.directStarted >= 3500) {
          p.directFailed = true;
          p.state = relayAllowed() ? QStringLiteral("No direct peer endpoint; connecting to encrypted relay…")
                                  : QStringLiteral("No direct peer endpoint · relay disabled");
        }
        if (!p.authenticated)
          relay(p);
      }
    }
    for (auto it = peers_.begin(); it != peers_.end();)
      if (!wanted.contains(it->first)) {
        close(*it->second);
        it = peers_.erase(it);
      } else
        ++it;
    setActive(downloads_, uploadsCount_);
  } catch (const AppError &e) {
    emit problem({}, e.message());
  }
}
void ShareTransport::ticket(const QString &room, const QString &other, const QJsonObject &result) {
  auto it = peers_.find(id(room, other));
  if (it == peers_.end())
    return;
  auto &p = *it->second;
  p.ticketPending = false;
  try {
    const auto key = sharing::deriveKey(
        privateKey_,
        QByteArray::fromBase64(result.value(QStringLiteral("peerPublicKey")).toString().toLatin1()),
        p.context);
    if (key != p.key) {
      close(p);
      p.key = key;
    }
    const auto relayAddress = result.value(QStringLiteral("relayUrl")).toString();
    if (!relayAddress.isEmpty())
      p.relay = RoomClient::validateServer(relayAddress);
    p.ticket = result.value(QStringLiteral("ticket")).toString();
    p.expires = result.value(QStringLiteral("expiresAt")).toInteger();
    const auto endpoint = result.value(QStringLiteral("peerEndpoint")).toObject();
    if (endpoint != p.endpoint && !p.authenticated) {
      p.directRetry = 0;
      p.directFailed = false;
      p.directStarted = now();
    }
    p.endpoint = endpoint;
    if (!p.directStarted)
      p.directStarted = now();
    emit changed();
  } catch (const AppError &e) {
    fail(p, e.message());
    emit problem(room, e.message());
  }
}
void ShareTransport::attach(Peer &p, QTcpSocket *socket, bool outgoing) {
  p.socket = socket;
  p.outgoing = outgoing;
  p.connecting = outgoing;
  p.authenticated = false;
  p.helloRead = !outgoing;
  p.input.clear();
  socket->setReadBufferSize(128 * 1024);
  const auto key = id(p.room, p.id);
  connect(socket, &QTcpSocket::readyRead, this, [this, key] {
    auto it = peers_.find(key);
    if (it != peers_.end())
      bytes(*it->second);
  });
  connect(socket, &QTcpSocket::disconnected, this, [this, key, socket] {
    auto it = peers_.find(key);
    if (it != peers_.end() && it->second->socket == socket)
      fail(*it->second, QStringLiteral("Direct link lost; using encrypted relay…"));
  });
  connect(socket, &QTcpSocket::errorOccurred, this, [this, key, socket](QAbstractSocket::SocketError) {
    auto it = peers_.find(key);
    if (it != peers_.end() && it->second->socket == socket)
      fail(*it->second, QStringLiteral("Direct connection unavailable; using encrypted relay…"));
  });
  auto greeting = [this, key] {
    auto it = peers_.find(key);
    if (it == peers_.end())
      return;
    auto &p = *it->second;
    p.connecting = false;
    const auto hello =
        encode({{QStringLiteral("room"), rooms_.credential(p.room).value(QStringLiteral("roomId"))},
                {QStringLiteral("from"), p.self},
                {QStringLiteral("to"), p.id}});
    p.output =
        frame(hello) + frame(sharing::seal(p.key, encode({{QStringLiteral("type"), QStringLiteral("hello")}}),
                                           p.context + '\0' + p.self.toUtf8()));
  };
  if (outgoing)
    connect(socket, &QTcpSocket::connected, this, greeting);
  else
    greeting();
}
void ShareTransport::adoptIncoming(Peer &p, QTcpSocket *socket, const QByteArray &input) {
  if (p.socket) {
    auto *previous = p.socket.data();
    disconnect(previous, nullptr, this, nullptr);
    previous->abort();
    previous->deleteLater();
    p.socket = nullptr;
  }
  attach(p, socket, false);
  p.input = input;
  bytes(p);
}
bool ShareTransport::promoteCandidate(Peer &p) {
  if (p.authenticated || !p.candidate || p.candidate->state() != QAbstractSocket::ConnectedState)
    return false;
  auto *socket = p.candidate.data();
  const auto input = p.candidateInput;
  p.candidate = nullptr;
  p.candidateInput.clear();
  adoptIncoming(p, socket, input);
  if (p.authenticated)
    ++p.standbyPromotions;
  return p.authenticated;
}
void ShareTransport::incoming(QTcpSocket *socket) {
  if (findChildren<QTcpSocket *>(QString(), Qt::FindDirectChildrenOnly).size() >= 64) {
    socket->abort();
    socket->deleteLater();
    return;
  }
  socket->setReadBufferSize(4096);
  socket->setParent(this);
  auto input = std::make_shared<QByteArray>();
  auto connection = std::make_shared<QMetaObject::Connection>();
  *connection = connect(socket, &QTcpSocket::readyRead, this, [this, socket, input, connection] {
    input->append(socket->read(std::max<qint64>(0, 4096 - input->size())));
    if (input->size() < 4)
      return;
    const auto size = qFromBigEndian<quint32>(input->constData());
    if (size > 1024) {
      socket->abort();
      return;
    }
    if (input->size() < int(size) + 4)
      return;
    const int afterHello = int(size) + 4;
    if (input->size() < afterHello + 4)
      return;
    const auto authenticatedSize = qFromBigEndian<quint32>(input->constData() + afterHello);
    if (authenticatedSize > 1024 || authenticatedSize < 2) {
      socket->abort();
      return;
    }
    if (input->size() < afterHello + 4 + int(authenticatedSize))
      return;
    const auto hello = QJsonDocument::fromJson(input->mid(4, size)).object();
    const auto from = hello.value(QStringLiteral("from")).toString();
    QString room;
    for (auto value : rooms_.rooms()) {
      const auto key = value.toObject().value(QStringLiteral("key")).toString();
      if (rooms_.connected(key) &&
          rooms_.credential(key).value(QStringLiteral("roomId")) == hello.value(QStringLiteral("room")) &&
          rooms_.credential(key).value(QStringLiteral("memberId")) == hello.value(QStringLiteral("to")))
        room = key;
    }
    if (room.isEmpty()) {
      socket->abort();
      return;
    }
    try {
      auto &p = peer(room, from);
      // Plaintext room/member IDs cannot displace a valid pending connection.
      // Authenticate the encrypted hello before considering any route change.
      const auto greeting = sharing::open(p.key, input->mid(afterHello + 4, int(authenticatedSize)),
                                          p.context + '\0' + p.id.toUtf8());
      if (QJsonDocument::fromJson(greeting).object().value(QStringLiteral("type")).toString() !=
          QStringLiteral("hello")) {
        socket->abort();
        return;
      }
      if (p.authenticated || p.candidate) {
        socket->abort();
        return;
      }
      disconnect(*connection);
      const auto authenticatedInput = input->mid(afterHello);
      if (p.socket)
        ++p.simultaneousRoutes;
      if (p.socket && p.outgoing && p.self < p.id) {
        // Simultaneous routes converge on the lower member's outgoing socket.
        // Keep the authenticated alternative until that outgoing attempt
        // actually fails or times out. A delayed response alone cannot prove
        // that the canonical route failed or that the alternative is alive.
        p.candidate = socket;
        p.candidateInput = authenticatedInput;
      } else
        adoptIncoming(p, socket, authenticatedInput);
    } catch (const AppError &) {
      socket->abort();
    }
  });
  connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
  QTimer::singleShot(4000, socket, [this, socket] {
    bool authenticated = false;
    for (const auto &[_, p] : peers_)
      if (p->socket == socket)
        authenticated = p->authenticated;
      else if (p->candidate == socket)
        authenticated = true; // Its encrypted hello was verified before storage.
    if (!authenticated)
      socket->abort();
  });
}
void ShareTransport::bytes(Peer &p) {
  if (!p.socket || p.socket->state() != QAbstractSocket::ConnectedState)
    return;
  const auto allowed = transfers_.downloadBudget()->take(std::min<qint64>(16384, p.socket->bytesAvailable()));
  if (allowed > 0)
    p.input += p.socket->read(allowed);
  while (p.input.size() >= 4) {
    const auto size = qFromBigEndian<quint32>(p.input.constData());
    if (size > 2 * 1024 * 1024 || size < 2) {
      fail(p, QStringLiteral("Invalid direct transfer frame."));
      return;
    }
    if (p.input.size() < int(size) + 4)
      return;
    const auto data = p.input.mid(4, size);
    p.input.remove(0, 4 + size);
    if (!p.helloRead) {
      const auto hello = QJsonDocument::fromJson(data).object();
      if (hello.value(QStringLiteral("room")) != rooms_.credential(p.room).value(QStringLiteral("roomId")) ||
          hello.value(QStringLiteral("from")).toString() != p.id ||
          hello.value(QStringLiteral("to")).toString() != p.self) {
        fail(p, QStringLiteral("Direct peer identity did not match."));
        return;
      }
      p.helloRead = true;
      continue;
    }
    packet(p, data, true);
    if (!p.socket)
      return;
  }
}
void ShareTransport::packet(Peer &p, const QByteArray &data, bool direct) {
  try {
    if (!rooms_.connected(p.room))
      return;
    bool authorized = false;
    for (auto value : rooms_.room(p.room).value(QStringLiteral("members")).toArray())
      if (value.toObject().value(QStringLiteral("id")).toString() == p.id) {
        const auto key = sharing::deriveKey(
            privateKey_,
            QByteArray::fromBase64(value.toObject().value(QStringLiteral("publicKey")).toString().toLatin1()),
            p.context);
        authorized = key == p.key;
      }
    if (!authorized) {
      fail(p, QStringLiteral("Peer access or sharing key changed."));
      return;
    }
    const auto decoded = sharing::open(p.key, data, p.context + '\0' + p.id.toUtf8());
    const auto object = QJsonDocument::fromJson(decoded).object();
    if (object.isEmpty())
      throw AppError(QStringLiteral("SHARE_FRAME"), QStringLiteral("Invalid encrypted message."));
    if (object.value(QStringLiteral("type")).toString() == QStringLiteral("hello")) {
      if (direct && p.socket) {
        p.authenticated = true;
        p.state = QStringLiteral("Direct · encrypted");
        if (p.candidate) {
          p.candidate->abort();
          p.candidate->deleteLater();
          p.candidate = nullptr;
          p.candidateInput.clear();
        }
        if (p.receive)
          p.receive->cancelled.store(true);
        if (p.upload)
          p.upload->cancelled.store(true);
        p.receive.reset();
        p.upload.reset();
        p.relayActive = false;
        emit changed();
      }
      return;
    }
    emit received(p.room, p.id, object);
  } catch (const AppError &e) {
    fail(p, e.message());
    emit problem(p.room, e.message());
  }
}
bool ShareTransport::send(const QString &room, const QString &other, const QJsonObject &message) {
  try {
    auto &p = peer(room, other);
    if (config_.value(QStringLiteral("offline")).toBool() || p.queue.size() >= 2)
      return false;
    if (!p.authenticated && !canRelay(p))
      return false;
    const auto encoded = encode(message);
    qint64 queued = 0;
    for (const auto &[_, other] : peers_) {
      queued += other->output.size() + other->uploadFrame.bytes.size();
      for (const auto &frame : other->queue)
        queued += frame.bytes.size();
    }
    if (queued + encoded.size() + 28 > 64 * 1024 * 1024)
      return false;
    p.queue.enqueue({sharing::seal(p.key, encoded, p.context + '\0' + p.self.toUtf8()),
                     message.value(QStringLiteral("type")).toString() == QStringLiteral("chunk")});
    setActive(downloads_, uploadsCount_);
    if (!p.authenticated)
      relay(p);
    return true;
  } catch (const AppError &) {
    return false;
  }
}
QString ShareTransport::mode(const QString &room, const QString &other) const {
  auto it = peers_.find(id(room, other));
  if (it == peers_.end())
    return QStringLiteral("Connecting to publisher…");
  const auto &p = *it->second;
  return p.authenticated ? QStringLiteral("Direct · encrypted")
         : p.relayActive ? QStringLiteral("Relay · end-to-end encrypted")
         : p.state.isEmpty() ? QStringLiteral("Preparing direct peer-to-peer connection…")
                             : p.state;
}
QJsonObject ShareTransport::diagnostics(const QString &room, const QString &other) const {
  auto it = peers_.find(id(room, other));
  return {{QStringLiteral("mode"), mode(room, other)},
          {QStringLiteral("relayAllowed"), relayAllowed()},
          {QStringLiteral("directAttempts"), it == peers_.end() ? 0 : it->second->directAttempts},
          {QStringLiteral("relayRequests"), it == peers_.end() ? 0 : it->second->relayRequests},
          {QStringLiteral("simultaneousRoutes"), it == peers_.end() ? 0 : it->second->simultaneousRoutes},
          {QStringLiteral("standbyPromotions"), it == peers_.end() ? 0 : it->second->standbyPromotions}};
}
bool ShareTransport::relayAllowed() const {
  return config_.value(QStringLiteral("sharingMode")).toString(QStringLiteral("p2p-relay")) !=
         QStringLiteral("p2p-only");
}
bool ShareTransport::canRelay(const Peer &p) const {
  return relayAllowed() && p.directFailed && !p.authenticated && !p.relay.isEmpty() &&
         !p.ticket.isEmpty() && p.expires >= now();
}
void ShareTransport::relay(Peer &p) {
  if (!canRelay(p) || config_.value(QStringLiteral("offline")).toBool() || now() < p.retry)
    return;
  const auto key = id(p.room, p.id);
  auto options = [&](bool send) {
    HttpOptions o;
    o.url = p.relay;
    o.url.setPath(send ? QStringLiteral("/v2/relay/send") : QStringLiteral("/v2/relay/receive"));
    o.headers.insert("Authorization", "Bearer " + p.ticket.toLatin1());
    o.followRedirects = false;
    o.reuseConnections = true;
    o.maximumBytes = 2 * 1024 * 1024;
    o.bindAddress = config_.value(QStringLiteral("bind")).toString();
    o.proxyHost = config_.value(QStringLiteral("proxyHost")).toString();
    o.proxyPort = config_.value(QStringLiteral("proxyPort")).toInt(1080);
    o.control = std::make_shared<HttpControl>();
    o.control->budget = transfers_.downloadBudget();
    o.control->uploadBudget = transfers_.uploadBudget();
    return o;
  };
  if (!p.receive) {
    ++p.relayRequests;
    auto o = options(false);
    p.receive = o.control;
    auto *watcher = new QFutureWatcher<HttpResult>(this);
    connect(watcher, &QFutureWatcher<HttpResult>::finished, this, [this, key, watcher, control = o.control] {
      const auto result = watcher->result();
      watcher->deleteLater();
      auto it = peers_.find(key);
      if (it == peers_.end() || it->second->receive != control)
        return;
      auto &p = *it->second;
      p.receive.reset();
      if (result.cancelled)
        return;
      if (result.status == 200 || result.status == 204) {
        p.relayActive = true;
        emit changed();
      }
      if (result.status == 200 && !result.body.isEmpty())
        packet(p, result.body);
      else if (result.status != 204) {
        p.retry = now() + 3000;
        if (result.status == 401)
          p.expires = 0;
      }
      relay(p);
    });
    watcher->setFuture(QtConcurrent::run(&receives_, [o] { return fetchHttp(o); }));
  }
  if (!p.upload && !p.queue.isEmpty()) {
    ++p.relayRequests;
    auto o = options(true);
    o.method = QStringLiteral("POST");
    o.headers.insert("Content-Type", "application/octet-stream");
    p.uploadFrame = p.queue.dequeue();
    o.body = p.uploadFrame.bytes;
    p.upload = o.control;
    auto *watcher = new QFutureWatcher<HttpResult>(this);
    connect(watcher, &QFutureWatcher<HttpResult>::finished, this, [this, key, watcher, control = o.control] {
      const auto result = watcher->result();
      watcher->deleteLater();
      auto it = peers_.find(key);
      if (it == peers_.end() || it->second->upload != control)
        return;
      auto &p = *it->second;
      const auto sent = p.uploadFrame;
      p.uploadFrame = {};
      p.upload.reset();
      if (result.cancelled)
        return;
      if (result.status == 202) {
        p.relayActive = true;
        emit changed();
        // This exact frame was removed at dispatch. A direct connection may
        // have consumed newer queued frames while the relay POST was in flight.
      } else {
        if (!sent.bytes.isEmpty() && p.queue.size() < 2)
          p.queue.prepend(sent);
        p.retry = now() + 1500;
        if (result.status == 401)
          p.expires = 0;
      }
      relay(p);
    });
    watcher->setFuture(QtConcurrent::run(&uploads_, [o] { return fetchHttp(o); }));
  }
}
} // namespace wp
