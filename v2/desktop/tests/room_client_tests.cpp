#include "coordinator_fixture.h"
#include "room_client.h"
#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QProcess>
#include <QTemporaryDir>
#include <QTimer>
#include <QtTest>

namespace {
class Server {
public:
  ~Server() { stop(); }
  void start(const QString &database, int existingPort = 0) {
    const auto script =
        QString::fromUtf8(WATCHPAIR_COORDINATOR_DIR) + QStringLiteral("/dist/tests/native-server.js");
    if (!QFileInfo::exists(script))
      throw std::runtime_error("Build the coordinator before running native integration tests");
    process.setProcessChannelMode(QProcess::SeparateChannels);
    process.start(qEnvironmentVariable("WATCHPAIR_NODE", QStringLiteral("node")),
                  {script, database, QString::number(existingPort)});
    if (!process.waitForStarted(5000))
      throw std::runtime_error("Cannot start the local coordinator test fixture");
    QElapsedTimer timer;
    timer.start();
    while (timer.elapsed() < 10000) {
      process.waitForReadyRead(100);
      while (process.canReadLine()) {
        const auto row = QJsonDocument::fromJson(process.readLine()).object();
        if (row.contains(QStringLiteral("port"))) {
          port = row.value(QStringLiteral("port")).toInt();
          return;
        }
      }
      if (process.state() == QProcess::NotRunning)
        break;
    }
    throw std::runtime_error(process.readAllStandardError().constData());
  }
  void stop() {
    if (process.state() != QProcess::NotRunning) {
      process.kill();
      process.waitForFinished(3000);
    }
  }
  QString url() const { return QStringLiteral("http://127.0.0.1:%1").arg(port); }
  bool dropNext(const QString &path) {
    process.write(
        QJsonDocument(QJsonObject{{QStringLiteral("dropPath"), path}}).toJson(QJsonDocument::Compact) + '\n');
    process.waitForBytesWritten(1000);
    QElapsedTimer timer;
    timer.start();
    while (timer.elapsed() < 3000) {
      process.waitForReadyRead(100);
      while (process.canReadLine())
        if (QJsonDocument::fromJson(process.readLine()).object().value(QStringLiteral("armed")).toBool())
          return true;
    }
    return false;
  }
  int port = 0;

private:
  QProcess process;
};
QJsonObject addPack() {
  QJsonArray files;
  for (int i : {10, 2, 1})
    files.append(QJsonObject{{QStringLiteral("mediaId"), QStringLiteral("bt:fixture:%1").arg(i)},
                             {QStringLiteral("path"), QStringLiteral("Show/S01/E%1.mkv").arg(i)},
                             {QStringLiteral("label"), QStringLiteral("Episode %1").arg(i)},
                             {QStringLiteral("fileIndex"), i},
                             {QStringLiteral("size"), 1000000},
                             {QStringLiteral("duration"), 100},
                             {QStringLiteral("selected"), true}});
  return {{QStringLiteral("type"), QStringLiteral("queue.add")},
          {QStringLiteral("source"),
           QJsonObject{{QStringLiteral("id"), QStringLiteral("pack")},
                       {QStringLiteral("kind"), QStringLiteral("torrent")},
                       {QStringLiteral("label"), QStringLiteral("Show")},
                       {QStringLiteral("uri"), QStringLiteral("magnet:?xt=urn:btih:fixture")},
                       {QStringLiteral("identity"), QStringLiteral("bt:fixture")}}},
          {QStringLiteral("files"), files}};
}
QJsonObject status(wp::RoomClient &client, const QString &key) {
  const auto room = client.room(key), p = room.value(QStringLiteral("playback")).toObject();
  QString identity;
  for (auto value : room.value(QStringLiteral("entries")).toArray())
    if (value.toObject().value(QStringLiteral("id")) == p.value(QStringLiteral("entryId")))
      identity = value.toObject().value(QStringLiteral("mediaId")).toString();
  return {{QStringLiteral("type"), QStringLiteral("status")},
          {QStringLiteral("generation"), p.value(QStringLiteral("generation"))},
          {QStringLiteral("entryId"), p.value(QStringLiteral("entryId"))},
          {QStringLiteral("ready"), true},
          {QStringLiteral("reason"), QString()},
          {QStringLiteral("position"), client.timelinePosition(key)},
          {QStringLiteral("duration"), 100},
          {QStringLiteral("identity"), identity},
          {QStringLiteral("audio"), QJsonArray{QStringLiteral("audio:0"), QStringLiteral("audio:1")}},
          {QStringLiteral("subtitles"), QJsonArray{QStringLiteral("sub:0")}}};
}
} // namespace
class RoomClients final : public QObject {
  Q_OBJECT
private slots:
  void expiredLiveSessionReconnectsAndDeletedRoomIsForgotten() {
    QTemporaryDir tmp;
    wp::test::Coordinator server;
    server.start(tmp.filePath(QStringLiteral("server.sqlite")));
    wp::LocalStore store(tmp.filePath(QStringLiteral("client")));
    wp::RoomClient client(store);
    QSignalSpy entered(&client, &wp::RoomClient::entered);
    client.create(server.url(), QStringLiteral("Sleep recovery"), QStringLiteral("Host"));
    QTRY_COMPARE_WITH_TIMEOUT(entered.size(), 1, 5000);
    const auto room = entered.first()[1].toString();
    QTRY_VERIFY_WITH_TIMEOUT(client.connected(room) && client.clockReady(room), 5000);
    bool disconnected = false;
    connect(&client, &wp::RoomClient::connectionChanged, this, [&](const QString &key) {
      if (key == room && !client.connected(room))
        disconnected = true;
    });
    QVERIFY(server.advance(6000));
    QTRY_VERIFY_WITH_TIMEOUT(disconnected, 4000);
    QTRY_VERIFY_WITH_TIMEOUT(client.connected(room) && client.clockReady(room), 8000);
    QVERIFY(std::abs(client.serverNow(room) - QDateTime::currentMSecsSinceEpoch() - 6000) < 300);
    client.command(room, {{QStringLiteral("type"), QStringLiteral("room.delete")}});
    QTRY_VERIFY_WITH_TIMEOUT(client.rooms().isEmpty(), 5000);
    QVERIFY(store.get(QStringLiteral("room-private"), room).isEmpty());
    QVERIFY(store.get(QStringLiteral("room-cache"), room).isEmpty());
  }
  void coordinatorValidation() {
    QCOMPARE(wp::RoomClient::validateServer(QStringLiteral("http://127.0.0.1:8787/")).toString(),
             QStringLiteral("http://127.0.0.1:8787"));
    for (const auto &text :
         {QStringLiteral("http://example.com"), QStringLiteral("https://user:password@example.com"),
          QStringLiteral("file:///tmp/server"), QStringLiteral("https://example.com/private"),
          QStringLiteral("https://example.com#secret")})
      QVERIFY_EXCEPTION_THROWN(wp::RoomClient::validateServer(text), wp::AppError);
  }
  void nativeClientsControlTheSameTimelineAndQueue() {
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    Server server;
    server.start(tmp.path() + QStringLiteral("/coordinator.sqlite"));
    wp::LocalStore hostStore(tmp.path() + QStringLiteral("/host")),
        guestStore(tmp.path() + QStringLiteral("/guest"));
    wp::RoomClient host(hostStore), guest(guestStore);
    QSignalSpy created(&host, &wp::RoomClient::entered);
    host.create(server.url(), QStringLiteral("Friday watch"), QStringLiteral("Host"));
    QTRY_COMPARE_WITH_TIMEOUT(created.size(), 1, 5000);
    const auto hostKey = created.first()[1].toString();
    QTRY_VERIFY_WITH_TIMEOUT(host.connected(hostKey) && host.clockReady(hostKey), 5000);
    QSignalSpy joined(&guest, &wp::RoomClient::entered);
    guest.join(host.inviteLink(hostKey), QStringLiteral("Guest"));
    QTRY_COMPARE_WITH_TIMEOUT(joined.size(), 1, 5000);
    const auto guestKey = joined.first()[1].toString();
    QTRY_VERIFY_WITH_TIMEOUT(guest.connected(guestKey) && guest.clockReady(guestKey), 5000);
    host.command(hostKey, addPack());
    QTRY_COMPARE_WITH_TIMEOUT(guest.room(guestKey).value(QStringLiteral("entries")).toArray().size(), 3,
                              5000);
    const auto entries = guest.room(guestKey).value(QStringLiteral("entries")).toArray();
    QCOMPARE(entries.first().toObject().value(QStringLiteral("fileIndex")).toInt(), 1);
    guest.command(guestKey,
                  {{QStringLiteral("type"), QStringLiteral("playback.choose")},
                   {QStringLiteral("entryId"), entries.first().toObject().value(QStringLiteral("id"))}});
    QTRY_COMPARE_WITH_TIMEOUT(
        host.room(hostKey).value(QStringLiteral("playback")).toObject().value(QStringLiteral("entryId")),
        entries.first().toObject().value(QStringLiteral("id")), 5000);
    QTimer reports;
    connect(&reports, &QTimer::timeout, this, [&] { guest.sendStatus(guestKey, status(guest, guestKey)); });
    reports.start(200);
    guest.command(guestKey, {{QStringLiteral("type"), QStringLiteral("watch.join")}});
    QTRY_COMPARE_WITH_TIMEOUT(host.room(hostKey)
                                  .value(QStringLiteral("members"))
                                  .toArray()
                                  .last()
                                  .toObject()
                                  .value(QStringLiteral("watch"))
                                  .toString(),
                              QStringLiteral("active"), 5000);
    host.command(hostKey, {{QStringLiteral("type"), QStringLiteral("playback.play")}});
    QTRY_VERIFY_WITH_TIMEOUT(!guest.room(guestKey)
                                  .value(QStringLiteral("playback"))
                                  .toObject()
                                  .value(QStringLiteral("paused"))
                                  .toBool(true),
                             5000);
    QTest::qWait(900);
    QVERIFY(guest.timelinePosition(guestKey) > 0.1);
    guest.command(guestKey, {{QStringLiteral("type"), QStringLiteral("playback.pause")}});
    QTRY_VERIFY_WITH_TIMEOUT(host.room(hostKey)
                                 .value(QStringLiteral("playback"))
                                 .toObject()
                                 .value(QStringLiteral("paused"))
                                 .toBool(),
                             5000);
    const auto position = host.timelinePosition(hostKey);
    QTest::qWait(500);
    QCOMPARE(host.timelinePosition(hostKey), position);
    guest.command(guestKey, {{QStringLiteral("type"), QStringLiteral("playback.seek")},
                             {QStringLiteral("position"), 42}});
    QTRY_COMPARE_WITH_TIMEOUT(host.timelinePosition(hostKey), 42.0, 5000);
    guest.command(guestKey, {{QStringLiteral("type"), QStringLiteral("queue.select")},
                             {QStringLiteral("sourceId"), QStringLiteral("pack")},
                             {QStringLiteral("mediaIds"), QJsonArray{QStringLiteral("bt:fixture:2")}}});
    QTRY_COMPARE_WITH_TIMEOUT(
        host.room(hostKey).value(QStringLiteral("playback")).toObject().value(QStringLiteral("entryId")),
        entries[1].toObject().value(QStringLiteral("id")), 5000);
    guest.command(guestKey, {{QStringLiteral("type"), QStringLiteral("member.rename")},
                             {QStringLiteral("name"), QStringLiteral("First name")}});
    guest.command(guestKey, {{QStringLiteral("type"), QStringLiteral("member.rename")},
                             {QStringLiteral("name"), QStringLiteral("Final name")}});
    QTRY_COMPARE_WITH_TIMEOUT(host.room(hostKey)
                                  .value(QStringLiteral("members"))
                                  .toArray()
                                  .last()
                                  .toObject()
                                  .value(QStringLiteral("name"))
                                  .toString(),
                              QStringLiteral("Final name"), 5000);
    QTRY_COMPARE_WITH_TIMEOUT(
        guestStore.find(QStringLiteral("room-command"), QStringLiteral("room"), guestKey).size(), 0, 5000);
    guest.command(guestKey,
                  {{QStringLiteral("type"), QStringLiteral("history.mark")},
                   {QStringLiteral("ids"), QJsonArray{entries[1].toObject().value(QStringLiteral("id"))}},
                   {QStringLiteral("watched"), true}});
    QTRY_VERIFY_WITH_TIMEOUT(!host.room(hostKey).value(QStringLiteral("history")).toArray().isEmpty(), 5000);
    QSignalSpy history(&host, &wp::RoomClient::historyLoaded);
    host.history(hostKey, {}, QStringLiteral("episode 2"));
    QTRY_COMPARE_WITH_TIMEOUT(history.size(), 1, 5000);
    QCOMPARE(history.first()[1].toJsonArray().size(), 1);
  }
  void lostResponsesRecoveryAndRestartKeepOneDurableOperation() {
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const auto database = tmp.path() + QStringLiteral("/coordinator.sqlite");
    Server server;
    server.start(database);
    wp::LocalStore hostStore(tmp.path() + QStringLiteral("/host")),
        recoveryStore(tmp.path() + QStringLiteral("/recovered"));
    wp::RoomClient host(hostStore), recovered(recoveryStore);
    QSignalSpy entryError(&host, &wp::RoomClient::error), created(&host, &wp::RoomClient::entered);
    QVERIFY(server.dropNext(QStringLiteral("/v2/rooms")));
    const auto creation = host.create(server.url(), QStringLiteral("Lost response"), QStringLiteral("Host"));
    // Qt's HTTP backend may transparently retry an empty-response POST. Both
    // that retry and our explicit retry retain the same private request key.
    QTRY_VERIFY_WITH_TIMEOUT(!entryError.isEmpty() || !created.isEmpty(), 5000);
    if (created.isEmpty()) {
      QCOMPARE(hostStore.all(QStringLiteral("entry-request")).size(), 1);
      host.retryEntry(creation);
    }
    QTRY_COMPARE_WITH_TIMEOUT(created.size(), 1, 5000);
    const auto key = created.first()[1].toString();
    QTRY_VERIFY_WITH_TIMEOUT(host.connected(key), 5000);
    QCOMPARE(host.rooms().size(), 1);
    QVERIFY(hostStore.all(QStringLiteral("entry-request")).isEmpty());
    QSignalSpy ack(&host, &wp::RoomClient::operationComplete);
    QVERIFY(server.dropNext(QStringLiteral("/commands")));
    const auto op = host.command(key, addPack());
    QTRY_COMPARE_WITH_TIMEOUT(host.room(key).value(QStringLiteral("queueRevision")).toInt(), 1, 5000);
    QTRY_VERIFY_WITH_TIMEOUT(!ack.isEmpty(), 8000);
    QCOMPARE(ack.last()[1].toString(), op);
    QCOMPARE(host.room(key).value(QStringLiteral("queueRevision")).toInt(), 1);
    QVERIFY(hostStore.find(QStringLiteral("room-command"), QStringLiteral("room"), key).isEmpty());
    const auto privateLink = host.inviteLink(key, true);
    QVERIFY(!privateLink.isEmpty());
    QSignalSpy restored(&recovered, &wp::RoomClient::entered);
    recovered.join(privateLink, QStringLiteral("Ignored"));
    QTRY_COMPARE_WITH_TIMEOUT(restored.size(), 1, 5000);
    const auto recoveredKey = restored.first()[1].toString();
    QTRY_VERIFY_WITH_TIMEOUT(recovered.connected(recoveredKey), 5000);
    QTRY_VERIFY_WITH_TIMEOUT(!host.connected(key), 5000);
    QVERIFY(recovered.inviteLink(recoveredKey, true) != privateLink);
    const auto before = recovered.room(recoveredKey)
                            .value(QStringLiteral("playback"))
                            .toObject()
                            .value(QStringLiteral("generation"))
                            .toInt();
    const auto port = server.port;
    server.stop();
    QTRY_VERIFY_WITH_TIMEOUT(!recovered.connected(recoveredKey), 5000);
    server.start(database, port);
    QTRY_VERIFY_WITH_TIMEOUT(recovered.connected(recoveredKey), 8000);
    QVERIFY(recovered.room(recoveredKey)
                .value(QStringLiteral("playback"))
                .toObject()
                .value(QStringLiteral("paused"))
                .toBool());
    QVERIFY(recovered.room(recoveredKey)
                .value(QStringLiteral("playback"))
                .toObject()
                .value(QStringLiteral("generation"))
                .toInt() > before);
    QCOMPARE(recovered.room(recoveredKey).value(QStringLiteral("entries")).toArray().size(), 3);
    QVERIFY(!host.connected(key));
  }
};
QTEST_GUILESS_MAIN(RoomClients)
#include "room_client_tests.moc"
