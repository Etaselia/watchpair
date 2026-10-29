#include "room_client.h"
#include <QCryptographicHash>
#include <QDateTime>
#include <QHostAddress>
#include <QJsonDocument>
#include <QRandomGenerator>
#include <QRegularExpression>
#include <QUrlQuery>
#include <QUuid>
#include <algorithm>
#include <cmath>
#include <cstring>
namespace wp {
namespace {
QString uuid() {
  return QUuid::createUuid().toString(QUuid::WithoutBraces);
}
QString secret() {
  QByteArray bytes(32, '\0');
  for (int i = 0; i < 32; i += 4) {
    const auto n = QRandomGenerator::system()->generate();
    std::memcpy(bytes.data() + i, &n, 4);
  }
  return QString::fromLatin1(bytes.toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals));
}
QString roomKey(const QString &server, const QString &id) {
  return QString::fromLatin1(
      QCryptographicHash::hash((server + QLatin1Char('/') + id).toUtf8(), QCryptographicHash::Sha256)
          .toHex());
}
QUrl endpoint(const QJsonObject &credential, const QString &suffix = {}) {
  return QUrl(credential.value(QStringLiteral("server")).toString() + QStringLiteral("/v2/rooms/") +
              credential.value(QStringLiteral("roomId")).toString() + suffix);
}
bool capability(const QString &value) {
  return QRegularExpression(QStringLiteral("^[A-Za-z0-9_-]{43}$")).match(value).hasMatch();
}
bool roomId(const QString &value) {
  return !QUuid(value).isNull();
}
} // namespace
RoomClient::RoomClient(LocalStore &store, QObject *parent) : QObject(parent), store_(store), network_(this) {
  clock_.start();
  epoch_ = QDateTime::currentMSecsSinceEpoch();
  commandSequence_ = store_.setting(QStringLiteral("commandSequence"), 0).toInteger();
  connect(&timer_, &QTimer::timeout, this, &RoomClient::tick);
  timer_.start(500);
}
RoomClient::~RoomClient() {
  timer_.stop();
  for (auto &[key, c] : connections_)
    if (c->socket) {
      disconnect(c->socket.get(), nullptr, this, nullptr);
      c->socket->abort();
    }
}
void RoomClient::shutdown() {
  stopping_ = true;
  timer_.stop();
  for (auto &[_, c] : connections_) {
    c->terminal = true;
    c->online = false;
    c->fresh = false;
    if (c->socket)
      c->socket->close();
  }
  for (auto *reply : network_.findChildren<QNetworkReply *>())
    reply->abort();
}
qint64 RoomClient::now() const {
  return epoch_ + clock_.elapsed();
}
RoomClient::Connection &RoomClient::connection(const QString &key) const {
  auto it = connections_.find(key);
  if (it == connections_.end())
    throw AppError(QStringLiteral("ROOM_MISSING"),
                   QStringLiteral("This room is no longer saved on this device."));
  return *it->second;
}
QUrl RoomClient::validateServer(const QString &text) {
  QUrl url(text.trimmed());
  QHostAddress address;
  const bool loopback = url.host().compare(QStringLiteral("localhost"), Qt::CaseInsensitive) == 0 ||
                        (address.setAddress(url.host()) && address.isLoopback());
  if (!url.isValid() || url.host().isEmpty() || !url.userInfo().isEmpty() || url.hasQuery() ||
      url.hasFragment() || (!url.path().isEmpty() && url.path() != QStringLiteral("/")) ||
      (url.scheme() != QStringLiteral("https") && !(url.scheme() == QStringLiteral("http") && loopback)))
    throw AppError(QStringLiteral("COORDINATOR_URL"),
                   QStringLiteral("Use the coordinator's HTTPS address. Plain HTTP is allowed only for local "
                                  "development on loopback."));
  url.setPath(QString());
  return url;
}
void RoomClient::request(const QUrl &url, const QByteArray &token, const QJsonObject *body, Reply callback) {
  QNetworkRequest request(url);
  request.setRawHeader("X-WatchPair-Protocol", "2");
  request.setRawHeader("Accept", "application/json");
  request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
  request.setTransferTimeout(15000);
  if (!token.isEmpty())
    request.setRawHeader("Authorization", "Bearer " + token);
  QNetworkReply *reply;
  if (body) {
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    reply = network_.post(request, QJsonDocument(*body).toJson(QJsonDocument::Compact));
  } else
    reply = network_.get(request);
  connect(reply, &QNetworkReply::readyRead, this, [reply] {
    if (reply->bytesAvailable() > 16 * 1024 * 1024)
      reply->abort();
  });
  connect(reply, &QNetworkReply::finished, this, [this, reply, callback = std::move(callback)] {
    if (stopping_) {
      reply->deleteLater();
      return;
    }
    const auto status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    const auto object = QJsonDocument::fromJson(reply->readAll()).object();
    const auto error = object.value(QStringLiteral("error")).toObject();
    reply->deleteLater();
    if (status >= 200 && status < 300 && reply->error() == QNetworkReply::NoError && !object.isEmpty())
      callback(object, status, {}, {});
    else
      callback(
          {}, status,
          error.value(QStringLiteral("code"))
              .toString(status ? QStringLiteral("COORDINATOR_RESPONSE") : QStringLiteral("CONNECTION_LOST")),
          error.value(QStringLiteral("message"))
              .toString(
                  QStringLiteral("Could not reach the coordinator securely. Check its address, connection, "
                                 "and certificate; the pending operation can be retried.")));
  });
}
void RoomClient::restore() {
  for (const auto value : store_.all(QStringLiteral("room-private"))) {
    try {
      install(value.toObject());
    } catch (const AppError &e) {
      emit error({}, e.code(), e.message(), {});
    }
  }
  for (const auto value : store_.all(QStringLiteral("entry-request"))) {
    try {
      retryEntry(value.toObject().value(QStringLiteral("id")).toString());
    } catch (const AppError &e) {
      emit error({}, e.code(), e.message(), {});
    }
  }
}
void RoomClient::install(const QJsonObject &value) {
  const auto id = value.value(QStringLiteral("roomId")).toString();
  const auto server = validateServer(value.value(QStringLiteral("server")).toString()).toString();
  if (!roomId(id) || !capability(value.value(QStringLiteral("token")).toString()) ||
      !roomId(value.value(QStringLiteral("memberId")).toString()))
    throw AppError(
        QStringLiteral("ROOM_CREDENTIAL"),
        QStringLiteral(
            "The saved room credential is incomplete. Join again or use the private recovery link."));
  const auto key = roomKey(server, id);
  auto it = connections_.find(key);
  if (it != connections_.end()) {
    if (it->second->credential.value(QStringLiteral("token")) != value.value(QStringLiteral("token"))) {
      store_.transaction([&] {
        for (auto item : store_.find(QStringLiteral("room-command"), QStringLiteral("room"), key)) {
          auto row = item.toObject();
          if (row.value(QStringLiteral("state")).toString() == QStringLiteral("pending")) {
            row.insert(QStringLiteral("state"), QStringLiteral("credential-replaced"));
            store_.put(QStringLiteral("room-command"), row.value(QStringLiteral("id")).toString(), row);
          }
        }
      });
    }
    if (it->second->socket) {
      disconnect(it->second->socket.get(), nullptr, this, nullptr);
      it->second->socket->abort();
    }
    connections_.erase(it);
  }
  auto c = std::make_unique<Connection>();
  c->credential = value;
  c->credential.insert(QStringLiteral("key"), key);
  c->snapshot = store_.get(QStringLiteral("room-cache"), key);
  connections_.emplace(key, std::move(c));
  emit roomAdded(key);
  begin(key);
}
QString RoomClient::create(const QString &server, const QString &name, const QString &member) {
  const auto origin = validateServer(server).toString(), op = uuid();
  store_.put(QStringLiteral("entry-request"), op,
             {{QStringLiteral("id"), op},
              {QStringLiteral("type"), QStringLiteral("create")},
              {QStringLiteral("server"), origin},
              {QStringLiteral("body"), QJsonObject{{QStringLiteral("name"), name},
                                                   {QStringLiteral("memberName"), member},
                                                   {QStringLiteral("retryKey"), secret()}}}});
  retryEntry(op);
  return op;
}
QString RoomClient::join(const QString &link, const QString &name) {
  QUrl url(link.trimmed());
  QString server, id, invite, recovery;
  if (url.scheme() == QStringLiteral("watchpair")) {
    const QUrlQuery query(url);
    server = query.queryItemValue(QStringLiteral("server"), QUrl::FullyDecoded);
    id = query.queryItemValue(QStringLiteral("room"));
  } else {
    server = url.adjusted(QUrl::RemovePath | QUrl::RemoveQuery | QUrl::RemoveFragment).toString();
    const auto path = url.path().split(QLatin1Char('/'), Qt::SkipEmptyParts);
    if (path.size() == 2 && path[0] == QStringLiteral("r"))
      id = path[1];
  }
  server = validateServer(server).toString();
  QUrlQuery fragment(url.fragment());
  invite = fragment.queryItemValue(QStringLiteral("invite"));
  recovery = fragment.queryItemValue(QStringLiteral("recovery"));
  if (!roomId(id) || (capability(invite) == capability(recovery)))
    throw AppError(
        QStringLiteral("INVITE_LINK"),
        QStringLiteral(
            "Paste a complete WatchPair invite or private recovery link, including its fragment."));
  const auto op = uuid();
  const bool recover = capability(recovery);
  QJsonObject body{{QStringLiteral("retryKey"), secret()}};
  if (recover)
    body.insert(QStringLiteral("recovery"), recovery);
  else {
    body.insert(QStringLiteral("invite"), invite);
    body.insert(QStringLiteral("name"), name);
  }
  store_.put(QStringLiteral("entry-request"), op,
             {{QStringLiteral("id"), op},
              {QStringLiteral("type"), recover ? QStringLiteral("recover") : QStringLiteral("join")},
              {QStringLiteral("server"), server},
              {QStringLiteral("roomId"), id},
              {QStringLiteral("body"), body}});
  retryEntry(op);
  return op;
}
void RoomClient::retryEntry(const QString &op) {
  if (entering_.contains(op))
    return;
  const auto row = store_.get(QStringLiteral("entry-request"), op);
  if (row.isEmpty())
    throw AppError(QStringLiteral("ENTRY_MISSING"),
                   QStringLiteral("This join attempt has already finished."));
  const auto server = validateServer(row.value(QStringLiteral("server")).toString()).toString(),
             type = row.value(QStringLiteral("type")).toString();
  const auto path = type == QStringLiteral("create")
                        ? QStringLiteral("/v2/rooms")
                        : QStringLiteral("/v2/rooms/") + row.value(QStringLiteral("roomId")).toString() +
                              QLatin1Char('/') + type;
  const auto body = row.value(QStringLiteral("body")).toObject();
  entering_.insert(op);
  request(QUrl(server + path), {}, &body,
          [this, op, server, row](QJsonObject result, int status, QString code, QString message) {
            entering_.remove(op);
            if (!code.isEmpty()) {
              if (status >= 400 && status < 500 && status != 429) {
                try {
                  store_.remove(QStringLiteral("entry-request"), op);
                } catch (...) {
                }
              }
              emit error({}, code, message, op);
              return;
            }
            try {
              const auto id = result.value(QStringLiteral("roomId")).toString();
              const auto key = roomKey(server, id);
              auto value = store_.get(QStringLiteral("room-private"), key);
              for (auto it = result.begin(); it != result.end(); ++it)
                value.insert(it.key(), it.value());
              value.insert(QStringLiteral("server"), server);
              value.insert(QStringLiteral("key"), key);
              if (!roomId(id) || !roomId(value.value(QStringLiteral("memberId")).toString()) ||
                  !capability(value.value(QStringLiteral("token")).toString()))
                throw AppError(QStringLiteral("ROOM_RESPONSE"),
                               QStringLiteral("The coordinator returned an invalid credential."));
              if (row.value(QStringLiteral("type")).toString() == QStringLiteral("join"))
                value.insert(QStringLiteral("invite"),
                             row.value(QStringLiteral("body")).toObject().value(QStringLiteral("invite")));
              store_.transaction([&] {
                store_.put(QStringLiteral("room-private"), key, value);
                store_.remove(QStringLiteral("entry-request"), op);
              });
              install(value);
              emit entered(op, key);
            } catch (const AppError &e) {
              emit error({}, e.code(), e.message(), op);
            }
          });
}
void RoomClient::begin(const QString &key) {
  auto &c = connection(key);
  if (c.terminal)
    return;
  if (c.socket) {
    disconnect(c.socket.get(), nullptr, this, nullptr);
    c.socket->abort();
  }
  c.socket = std::make_unique<QWebSocket>();
  c.socket->setMaxAllowedIncomingMessageSize(16 * 1024 * 1024);
  c.socket->setMaxAllowedIncomingFrameSize(16 * 1024 * 1024);
  const auto epoch = c.epoch = ++connectionEpoch_;
  c.online = false;
  c.fresh = false;
  c.bestRtt = 1e20;
  c.clockSamples.clear();
  c.state = QStringLiteral("Connecting…");
  QUrl url = endpoint(c.credential, QStringLiteral("/events"));
  url.setScheme(url.scheme() == QStringLiteral("https") ? QStringLiteral("wss") : QStringLiteral("ws"));
  QNetworkRequest request(url);
  request.setRawHeader("X-WatchPair-Protocol", "2");
  request.setRawHeader("Authorization",
                       "Bearer " + c.credential.value(QStringLiteral("token")).toString().toLatin1());
  connect(c.socket.get(), &QWebSocket::connected, this, [this, key, epoch] {
    if (!connections_.contains(key))
      return;
    auto &c = connection(key);
    if (c.epoch != epoch)
      return;
    c.lastPong = now();
    c.attempts = 0;
    c.retryAt = 0;
    c.state = QStringLiteral("Synchronizing…");
    c.socket->sendTextMessage(
        QString::fromUtf8(QJsonDocument(QJsonObject{{QStringLiteral("type"), QStringLiteral("ping")},
                                                    {QStringLiteral("clientTime"), double(now())}})
                              .toJson(QJsonDocument::Compact)));
    emit connectionChanged(key);
  });
  connect(c.socket.get(), &QWebSocket::textMessageReceived, this,
          [this, key, epoch](const QString &text) { message(key, epoch, text); });
  connect(c.socket.get(), &QWebSocket::disconnected, this, [this, key, epoch] {
    if (!connections_.contains(key))
      return;
    auto &c = connection(key);
    if (c.epoch != epoch)
      return;
    c.online = false;
    c.fresh = false;
    const auto code = int(c.socket->closeCode());
    c.terminal = c.terminal || code == 4001 || code == 4003 || code == 4004;
    c.state = code == 4001   ? QStringLiteral("Open in another session. Reconnect to take over.")
              : code == 4003 ? QStringLiteral("Room access was revoked. Join with a new invite.")
              : code == 4004 ? QStringLiteral("Room deleted")
                             : QStringLiteral("Disconnected. Reconnecting…");
    c.retryAt = now() + std::min(30000, 1000 * (1 << std::min(5, c.attempts++)));
    emit connectionChanged(key);
    if (code == 4004)
      deleted(key);
  });
#if QT_VERSION >= QT_VERSION_CHECK(6, 5, 0)
  connect(c.socket.get(), &QWebSocket::errorOccurred, this, [this, key, epoch](QAbstractSocket::SocketError) {
#else
  connect(c.socket.get(), qOverload<QAbstractSocket::SocketError>(&QWebSocket::error), this,
          [this, key, epoch](QAbstractSocket::SocketError) {
#endif
    if (!connections_.contains(key))
      return;
    auto &c = connection(key);
    if (c.epoch != epoch)
      return;
    c.state = QStringLiteral("Connection failed. Checking coordinator access…");
    emit connectionChanged(key);
    refresh(key);
  });
  c.lastPong = now();
  c.retryAt = now() + 15000;
  c.socket->open(request);
  emit connectionChanged(key);
}
void RoomClient::message(const QString &key, quint64 epoch, const QString &text) {
  try {
    if (!connections_.contains(key))
      return;
    auto &c = connection(key);
    if (c.epoch != epoch)
      return;
    const auto event = QJsonDocument::fromJson(text.toUtf8()).object();
    const auto type = event.value(QStringLiteral("type")).toString();
    if (type == QStringLiteral("pong")) {
      const double sent = event.value(QStringLiteral("clientTime")).toDouble(), rtt = now() - sent;
      if (rtt >= 0 && rtt < 15000 && event.value(QStringLiteral("serverTime")).toDouble() > 0) {
        c.lastPong = now();
        c.clockSamples.append(
            {rtt, event.value(QStringLiteral("serverTime")).toDouble() - (now() + sent) / 2});
        while (c.clockSamples.size() > 30)
          c.clockSamples.removeFirst();
        const auto best = std::min_element(c.clockSamples.begin(), c.clockSamples.end(),
                                           [](const auto &a, const auto &b) { return a.first < b.first; });
        c.bestRtt = best->first;
        c.offset = best->second;
      }
      return;
    }
    if (type == QStringLiteral("error")) {
      const auto e = event.value(QStringLiteral("error")).toObject();
      emit error(key, e.value(QStringLiteral("code")).toString(),
                 e.value(QStringLiteral("message")).toString(), {});
      return;
    }
    if (type == QStringLiteral("deleted")) {
      deleted(key);
      return;
    }
    const auto data = event.value(QStringLiteral("data")).toObject();
    const auto revision = event.value(QStringLiteral("revision")).toInteger(-1),
               previous = c.snapshot.value(QStringLiteral("revision")).toInteger(-1);
    if (type == QStringLiteral("snapshot")) {
      if (c.fresh && revision < previous)
        return;
      apply(key, data, true);
      c.online = true;
      c.fresh = true;
      c.state = QStringLiteral("Connected");
      emit connectionChanged(key);
      flush(key);
      return;
    }
    if (!c.fresh || revision < previous)
      return;
    if (revision > previous + 1) {
      c.fresh = false;
      c.online = false;
      refresh(key);
      emit connectionChanged(key);
      return;
    }
    if (type == QStringLiteral("state"))
      apply(key, data, false);
    else if (type == QStringLiteral("presence")) {
      const auto member = data.value(QStringLiteral("member")).toObject();
      auto members = c.snapshot.value(QStringLiteral("members")).toArray();
      for (int i = 0; i < members.size(); ++i)
        if (members[i].toObject().value(QStringLiteral("id")) == member.value(QStringLiteral("id"))) {
          members[i] = member;
          break;
        }
      c.snapshot.insert(QStringLiteral("members"), members);
      emit changed(key);
    }
  } catch (const AppError &e) {
    auto &c = connection(key);
    if (e.code() == QStringLiteral("PROTOCOL_RESPONSE")) {
      c.terminal = true;
      c.online = false;
      c.state = e.message();
      if (c.socket)
        c.socket->close(QWebSocketProtocol::CloseCodeProtocolError);
      emit connectionChanged(key);
    }
    emit error(key, e.code(), e.message(), {});
  }
}
void RoomClient::apply(const QString &key, const QJsonObject &data, bool snapshot) {
  auto &c = connection(key);
  const auto oldQueue = c.snapshot.value(QStringLiteral("queueRevision")).toInteger(-1);
  if (data.value(QStringLiteral("id")) != c.credential.value(QStringLiteral("roomId")) ||
      !data.value(QStringLiteral("playback")).isObject() ||
      !data.value(QStringLiteral("members")).isArray() ||
      (snapshot && (!data.value(QStringLiteral("entries")).isArray() ||
                    data.value(QStringLiteral("protocol")).toInt() != 2)))
    throw AppError(QStringLiteral("PROTOCOL_RESPONSE"),
                   QStringLiteral("The coordinator sent an incompatible room snapshot. Update the "
                                  "application and coordinator together."));
  if (snapshot) {
    c.snapshot = data;
    c.entryIndexes.clear();
    const auto entries = data.value(QStringLiteral("entries")).toArray();
    for (int i = 0; i < entries.size(); ++i)
      c.entryIndexes.insert(entries[i].toObject().value(QStringLiteral("id")).toString(), i);
    store_.put(QStringLiteral("room-cache"), key, data);
  } else {
    for (auto it = data.begin(); it != data.end(); ++it)
      if (it.key() != QStringLiteral("entries") && it.key() != QStringLiteral("history"))
        c.snapshot.insert(it.key(), it.value());
    if (data.contains(QStringLiteral("entries"))) {
      auto entries = c.snapshot.value(QStringLiteral("entries")).toArray();
      for (auto value : data.value(QStringLiteral("entries")).toArray()) {
        const auto e = value.toObject();
        auto it = c.entryIndexes.find(e.value(QStringLiteral("id")).toString());
        if (it != c.entryIndexes.end())
          entries[it.value()] = e;
      }
      c.snapshot.insert(QStringLiteral("entries"), entries);
    }
    if (data.contains(QStringLiteral("history"))) {
      auto history = c.snapshot.value(QStringLiteral("history")).toArray();
      QSet<QString> known;
      for (auto e : history)
        known.insert(e.toObject().value(QStringLiteral("id")).toString());
      for (auto value : data.value(QStringLiteral("history")).toArray())
        if (!known.contains(value.toObject().value(QStringLiteral("id")).toString()))
          history.prepend(value);
      while (history.size() > 200)
        history.removeLast();
      c.snapshot.insert(QStringLiteral("history"), history);
    }
  }
  if (snapshot || oldQueue != c.snapshot.value(QStringLiteral("queueRevision")).toInteger() ||
      data.contains(QStringLiteral("entries")))
    emit queueChanged(key);
  emit changed(key);
}
QString RoomClient::command(const QString &key, const QJsonObject &cmd, Preparation preparation,
                            const QJsonObject &expected) {
  auto &c = connection(key);
  if (!connected(key))
    throw AppError(QStringLiteral("ROOM_OFFLINE"),
                   QStringLiteral("Wait for the room to reconnect before changing shared state."));
  const auto op = uuid(), type = cmd.value(QStringLiteral("type")).toString();
  QJsonObject envelope{{QStringLiteral("operationId"), op}, {QStringLiteral("command"), cmd}};
  if ((type.startsWith(QStringLiteral("queue.")) && type != QStringLiteral("queue.identify")) ||
      type.startsWith(QStringLiteral("history.")) || type == QStringLiteral("source.remove"))
    envelope.insert(QStringLiteral("queueRevision"), c.snapshot.value(QStringLiteral("queueRevision")));
  if (type.startsWith(QStringLiteral("playback.")) || type == QStringLiteral("tracks.select"))
    envelope.insert(
        QStringLiteral("generation"),
        c.snapshot.value(QStringLiteral("playback")).toObject().value(QStringLiteral("generation")));
  for (auto it = expected.begin(); it != expected.end(); ++it) {
    if ((it.key() != QStringLiteral("queueRevision") && it.key() != QStringLiteral("generation")) ||
        !it.value().isDouble() || it.value().toDouble() < 0)
      throw AppError(QStringLiteral("EXPECTED_STATE"),
                     QStringLiteral("The edit's original room revision is invalid."));
    envelope.insert(it.key(), it.value());
  }
  int pending = 0;
  for (auto item : store_.find(QStringLiteral("room-command"), QStringLiteral("room"), key))
    if (item.toObject().value(QStringLiteral("state")).toString() == QStringLiteral("pending"))
      ++pending;
  if (pending >= 100)
    throw AppError(QStringLiteral("COMMANDS_PENDING"),
                   QStringLiteral("Wait for pending room changes to finish before adding more."));
  const auto sequence = ++commandSequence_;
  store_.transaction([&] {
    store_.put(QStringLiteral("room-command"), op,
               {{QStringLiteral("id"), op},
                {QStringLiteral("room"), key},
                {QStringLiteral("sequence"), sequence},
                {QStringLiteral("envelope"), envelope},
                {QStringLiteral("baseRevision"), c.snapshot.value(QStringLiteral("revision"))},
                {QStringLiteral("state"), QStringLiteral("pending")}});
    store_.setSetting(QStringLiteral("commandSequence"), sequence);
    if (preparation)
      preparation(op);
  });
  flush(key);
  return op;
}
void RoomClient::flush(const QString &key) {
  auto &c = connection(key);
  if (!connected(key) || c.requesting || now() < c.retryAt)
    return;
  const auto rows = store_.find(QStringLiteral("room-command"), QStringLiteral("room"), key);
  QJsonObject row;
  // Pending commands retain their original envelope, revisions and operation
  // IDs. A reconnect never rebases an old edit onto somebody else's changes.
  for (auto value : rows)
    if (value.toObject().value(QStringLiteral("state")).toString() == QStringLiteral("pending") &&
        (row.isEmpty() || value.toObject().value(QStringLiteral("sequence")).toInteger() <
                              row.value(QStringLiteral("sequence")).toInteger()))
      row = value.toObject();
  if (row.isEmpty())
    return;
  const auto op = row.value(QStringLiteral("id")).toString();
  if (c.snapshot.value(QStringLiteral("revision")).toInteger() -
          row.value(QStringLiteral("baseRevision")).toInteger() >
      10000) {
    auto next = row;
    next.insert(QStringLiteral("state"), QStringLiteral("expired"));
    store_.put(QStringLiteral("room-command"), op, next);
    emit error(key, QStringLiteral("OPERATION_EXPIRED"),
               QStringLiteral("An old pending edit is outside the retry window. Review the current room "
                              "before applying it again."),
               op);
    return;
  }
  const auto envelope = row.value(QStringLiteral("envelope")).toObject();
  c.requesting = true;
  const auto credential = c.credential.value(QStringLiteral("token")).toString();
  request(endpoint(c.credential, QStringLiteral("/commands")), credential.toLatin1(), &envelope,
          [this, key, op, row, credential](QJsonObject ack, int status, QString code, QString message) {
            if (!connections_.contains(key))
              return;
            auto &c = connection(key);
            if (c.credential.value(QStringLiteral("token")).toString() != credential)
              return;
            c.requesting = false;
            try {
              if (code.isEmpty()) {
                auto credentials = c.credential;
                const auto type = row.value(QStringLiteral("envelope"))
                                      .toObject()
                                      .value(QStringLiteral("command"))
                                      .toObject()
                                      .value(QStringLiteral("type"))
                                      .toString();
                if (ack.value(QStringLiteral("secretCurrent")).toBool() &&
                    capability(ack.value(QStringLiteral("secret")).toString()))
                  credentials.insert(type == QStringLiteral("room.rotate-invite")
                                         ? QStringLiteral("invite")
                                         : QStringLiteral("recovery"),
                                     ack.value(QStringLiteral("secret")));
                store_.transaction([&] {
                  store_.put(QStringLiteral("room-private"), key, credentials);
                  store_.remove(QStringLiteral("room-command"), op);
                });
                c.credential = credentials;
                emit changed(key);
                emit operationComplete(key, op);
                if (type == QStringLiteral("room.delete")) {
                  deleted(key);
                  return;
                }
                flush(key);
              } else if (status == 0 || status >= 500 || status == 429) {
                c.retryAt = now() + (status == 429 ? 30000 : 3000);
                emit error(key, code, message, op);
              } else {
                if (code == QStringLiteral("ROOM_NOT_FOUND")) {
                  deleted(key);
                  return;
                }
                auto next = row;
                next.insert(QStringLiteral("state"), QStringLiteral("failed"));
                next.insert(QStringLiteral("error"), code);
                store_.put(QStringLiteral("room-command"), op, next);
                emit error(key, code, message, op);
                if (status == 409)
                  refresh(key);
                flush(key);
              }
            } catch (const AppError &e) {
              emit error(key, e.code(), e.message(), op);
            }
          });
}
void RoomClient::tick() {
  for (auto &[key, c] : connections_) {
    if (c->socket && c->socket->state() == QAbstractSocket::ConnectedState) {
      if (now() - c->lastPong > 3000) {
        c->online = false;
        c->fresh = false;
        c->state = QStringLiteral("Coordinator heartbeat lost. Playback paused.");
        emit connectionChanged(key);
        c->socket->abort();
        continue;
      }
      c->socket->sendTextMessage(
          QString::fromUtf8(QJsonDocument(QJsonObject{{QStringLiteral("type"), QStringLiteral("ping")},
                                                      {QStringLiteral("clientTime"), double(now())}})
                                .toJson(QJsonDocument::Compact)));
      try {
        flush(key);
      } catch (const AppError &e) {
        emit error(key, e.code(), e.message(), {});
      }
    } else if (!c->terminal && now() >= c->retryAt)
      begin(key);
  }
}
void RoomClient::refresh(const QString &key) {
  auto &c = connection(key);
  if (c.refreshing)
    return;
  c.refreshing = true;
  const auto epoch = c.epoch;
  request(endpoint(c.credential), c.credential.value(QStringLiteral("token")).toString().toLatin1(), nullptr,
          [this, key, epoch](QJsonObject data, int status, QString code, QString message) {
            if (!connections_.contains(key))
              return;
            auto &c = connection(key);
            c.refreshing = false;
            if (c.epoch != epoch)
              return;
            if (!code.isEmpty()) {
              if (code == QStringLiteral("ROOM_NOT_FOUND")) {
                deleted(key);
                return;
              }
              if (status == 401 || status == 403 || status == 404 || status == 426) {
                c.terminal = true;
                c.online = false;
                c.fresh = false;
                c.state = message;
                if (c.socket)
                  c.socket->abort();
                emit connectionChanged(key);
              }
              emit error(key, code, message, {});
              return;
            }
            try {
              if (data.value(QStringLiteral("revision")).toInteger() <
                  c.snapshot.value(QStringLiteral("revision")).toInteger())
                return;
              apply(key, data, true);
              c.fresh = true;
              c.online = c.socket && c.socket->state() == QAbstractSocket::ConnectedState;
              emit connectionChanged(key);
            } catch (const AppError &e) {
              emit error(key, e.code(), e.message(), {});
            }
          });
}
void RoomClient::sendStatus(const QString &key, const QJsonObject &status) {
  auto &c = connection(key);
  if (connected(key) && c.socket->bytesToWrite() < 64 * 1024)
    c.socket->sendTextMessage(QString::fromUtf8(QJsonDocument(status).toJson(QJsonDocument::Compact)));
}
void RoomClient::transferTicket(const QString &key, const QString &peer, quint16 listenPort) {
  auto &c = connection(key);
  const auto epoch = c.epoch;
  const QJsonObject body{{QStringLiteral("peerId"), peer}, {QStringLiteral("listenPort"), int(listenPort)}};
  request(endpoint(c.credential, QStringLiteral("/transfer-ticket")),
          c.credential.value(QStringLiteral("token")).toString().toLatin1(), &body,
          [this, key, peer, epoch](QJsonObject data, int, QString code, QString message) {
            if (!connections_.contains(key) || connection(key).epoch != epoch)
              return;
            if (code.isEmpty())
              emit ticketReady(key, peer, data);
            else
              emit error(key, code, message, {});
          });
}
void RoomClient::history(const QString &key, const QJsonObject &cursor, const QString &search) {
  auto &c = connection(key);
  if (cursor.isEmpty())
    ++c.historyEpoch;
  const auto historyEpoch = c.historyEpoch, connectionEpoch = c.epoch;
  QUrl url = endpoint(c.credential, QStringLiteral("/history"));
  QUrlQuery query;
  if (!cursor.isEmpty()) {
    query.addQueryItem(QStringLiteral("beforeTime"),
                       QString::number(cursor.value(QStringLiteral("watchedAt")).toInteger()));
    query.addQueryItem(QStringLiteral("beforeId"), cursor.value(QStringLiteral("id")).toString());
  }
  if (!search.isEmpty())
    query.addQueryItem(QStringLiteral("search"), search);
  url.setQuery(query);
  request(url, c.credential.value(QStringLiteral("token")).toString().toLatin1(), nullptr,
          [this, key, historyEpoch, connectionEpoch,
           first = cursor.isEmpty()](QJsonObject data, int, QString code, QString message) {
            if (!connections_.contains(key) || connection(key).epoch != connectionEpoch ||
                connection(key).historyEpoch != historyEpoch)
              return;
            if (!code.isEmpty())
              emit error(key, code, message, {});
            else
              emit historyLoaded(key, data.value(QStringLiteral("items")).toArray(), first);
          });
}
void RoomClient::forget(const QString &key) {
  auto &c = connection(key);
  if (c.socket) {
    disconnect(c.socket.get(), nullptr, this, nullptr);
    c.socket->close();
  }
  store_.transaction([&] {
    store_.remove(QStringLiteral("room-private"), key);
    store_.remove(QStringLiteral("room-cache"), key);
    for (auto v : store_.find(QStringLiteral("room-command"), QStringLiteral("room"), key))
      store_.remove(QStringLiteral("room-command"), v.toObject().value(QStringLiteral("id")).toString());
  });
  connections_.erase(key);
  emit roomRemoved(key);
}
void RoomClient::reconnect(const QString &key) {
  auto &c = connection(key);
  c.terminal = false;
  c.retryAt = 0;
  begin(key);
}
QJsonArray RoomClient::rooms() const {
  QJsonArray rows;
  for (const auto &[key, c] : connections_)
    rows.append(
        QJsonObject{{QStringLiteral("key"), key},
                    {QStringLiteral("name"),
                     c->snapshot.value(QStringLiteral("name")).toString(QStringLiteral("Connecting room…"))},
                    {QStringLiteral("connected"), c->online && c->fresh},
                    {QStringLiteral("state"), c->state}});
  return rows;
}
QJsonObject RoomClient::room(const QString &key) const {
  return connection(key).snapshot;
}
QJsonObject RoomClient::entry(const QString &key, const QString &id) const {
  const auto &c = connection(key);
  const auto index = c.entryIndexes.value(id, -1);
  const auto entries = c.snapshot.value(QStringLiteral("entries")).toArray();
  return index >= 0 && index < entries.size() ? entries[index].toObject() : QJsonObject();
}
QJsonObject RoomClient::credential(const QString &key) const {
  return connection(key).credential;
}
bool RoomClient::connected(const QString &key) const {
  const auto it = connections_.find(key);
  return it != connections_.end() && it->second->online && it->second->fresh;
}
bool RoomClient::clockReady(const QString &key) const {
  return connection(key).bestRtt < 1e20;
}
QString RoomClient::connectionState(const QString &key) const {
  return connection(key).state;
}
double RoomClient::serverNow(const QString &key) const {
  return now() + connection(key).offset;
}
double RoomClient::timelinePosition(const QString &key) const {
  const auto p = connection(key).snapshot.value(QStringLiteral("playback")).toObject();
  const auto position = std::max(
      0.0,
      p.value(QStringLiteral("position")).toDouble() +
          (p.value(QStringLiteral("paused")).toBool(true)
               ? 0
               : std::max(0.0, serverNow(key) - p.value(QStringLiteral("startsAt"))
                                                    .toDouble(p.value(QStringLiteral("anchor")).toDouble())) /
                     1000 * p.value(QStringLiteral("rate")).toDouble(1)));
  const auto duration =
      entry(key, p.value(QStringLiteral("entryId")).toString()).value(QStringLiteral("duration")).toDouble();
  return duration > 0 ? std::min(position, duration) : position;
}
QString RoomClient::inviteLink(const QString &key, bool recovery) const {
  const auto &c = connection(key);
  const auto secret =
      c.credential.value(recovery ? QStringLiteral("recovery") : QStringLiteral("invite")).toString();
  if (!capability(secret))
    return {};
  const auto digest = QCryptographicHash::hash(secret.toUtf8(), QCryptographicHash::Sha256).toHex();
  const auto version =
      QString::fromLatin1(QCryptographicHash::hash(digest, QCryptographicHash::Sha256).toHex());
  if (c.snapshot.value(recovery ? QStringLiteral("recoveryVersion") : QStringLiteral("inviteVersion")) !=
      version)
    return {};
  QUrl url(c.credential.value(QStringLiteral("server")).toString() + QStringLiteral("/r/") +
           c.credential.value(QStringLiteral("roomId")).toString());
  url.setFragment((recovery ? QStringLiteral("recovery=") : QStringLiteral("invite=")) + secret);
  return url.toString();
}
void RoomClient::deleted(const QString &key) {
  if (!connections_.contains(key))
    return;
  auto &c = connection(key);
  c.terminal = true;
  c.online = false;
  c.fresh = false;
  c.state = QStringLiteral("Room deleted");
  emit connectionChanged(key);
  // Deleting QWebSocket from inside its own message callback is unsafe.
  QTimer::singleShot(0, this, [this, key] {
    if (connections_.contains(key)) {
      try {
        forget(key);
      } catch (const AppError &e) {
        emit error(key, e.code(), e.message(), {});
      }
    }
  });
}
} // namespace wp
