#include "app_services.h"
#include "coordinator_fixture.h"
#include "native_runtime.h"
#include <QCryptographicHash>
#include <QFile>
#include <QFileInfo>
#include <QProcess>
#include <QTemporaryDir>
#include <QtTest>
namespace {
QJsonObject sourceFile(wp::AppServices &device, const QString &path) {
  QSignalSpy identified(&device.library, &wp::LibraryService::identified);
  device.library.identify(path);
  QElapsedTimer timer;
  timer.start();
  while (identified.isEmpty() && timer.elapsed() < 10000)
    QTest::qWait(20);
  if (identified.isEmpty())
    throw std::runtime_error("Identification timed out");
  return identified.first()[1].toJsonObject();
}
QJsonObject playback(wp::AppServices &app, const QString &room) {
  return app.rooms.room(room).value(QStringLiteral("playback")).toObject();
}
QString watch(wp::AppServices &app, const QString &room, const QString &member) {
  for (auto value : app.rooms.room(room).value(QStringLiteral("members")).toArray())
    if (value.toObject().value(QStringLiteral("id")).toString() == member)
      return value.toObject().value(QStringLiteral("watch")).toString();
  return {};
}
QString nativeSubtitle(wp::Player &player) {
  auto *value = mpv_get_property_string(player.native(), "sid");
  const auto result = QString::fromUtf8(value ? value : "<unavailable>");
  mpv_free(value);
  return result;
}
} // namespace
class PlaybackTests final : public QObject {
  Q_OBJECT
private slots:
  void episodeSubtitleFallbackIsSharedAndExplicitMissingSelectionStillBlocks() {
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const auto captions = tmp.filePath(QStringLiteral("captions.srt"));
    QFile subtitle(captions);
    QVERIFY(subtitle.open(QIODevice::WriteOnly));
    subtitle.write("1\n00:00:00,000 --> 00:00:12,000\nEpisode one captions\n");
    subtitle.close();
    const QStringList paths{tmp.filePath(QStringLiteral("with-captions.mkv")),
                            tmp.filePath(QStringLiteral("without-captions.mkv"))};
    for (int i = 0; i < paths.size(); ++i) {
      QStringList arguments{QStringLiteral("-hide_banner"),
                            QStringLiteral("-loglevel"),
                            QStringLiteral("error"),
                            QStringLiteral("-f"),
                            QStringLiteral("lavfi"),
                            QStringLiteral("-i"),
                            QStringLiteral("testsrc2=size=160x90:rate=12:duration=12")};
      if (i == 0)
        arguments << QStringLiteral("-i") << captions << QStringLiteral("-c:s") << QStringLiteral("srt");
      arguments << QStringLiteral("-c:v") << QStringLiteral("libx264") << QStringLiteral("-preset")
                << QStringLiteral("ultrafast") << paths[i];
      QProcess ffmpeg;
      ffmpeg.start(QStringLiteral("ffmpeg"), arguments);
      QVERIFY(ffmpeg.waitForFinished(30000));
      QVERIFY2(ffmpeg.exitCode() == 0, ffmpeg.readAllStandardError().constData());
    }
    wp::test::Coordinator server;
    server.start(tmp.filePath(QStringLiteral("coordinator.sqlite")));
    wp::AppServices host(tmp.filePath(QStringLiteral("host")), nullptr, true, true);
    wp::AppServices guest(tmp.filePath(QStringLiteral("guest")), nullptr, true, true);
    QList<QJsonObject> files;
    for (const auto &path : paths) {
      files.append(sourceFile(host, path));
      sourceFile(guest, path);
    }
    QSignalSpy created(&host.rooms, &wp::RoomClient::entered);
    host.rooms.create(server.url(), QStringLiteral("Episode subtitles"), QStringLiteral("Host"));
    QTRY_COMPARE_WITH_TIMEOUT(created.size(), 1, 5000);
    const auto room = created.first()[1].toString();
    QTRY_VERIFY_WITH_TIMEOUT(host.rooms.connected(room), 5000);
    QSignalSpy entered(&guest.rooms, &wp::RoomClient::entered);
    guest.rooms.join(host.rooms.inviteLink(room), QStringLiteral("Guest"));
    QTRY_COMPARE_WITH_TIMEOUT(entered.size(), 1, 5000);
    QTRY_VERIFY_WITH_TIMEOUT(guest.rooms.connected(room), 5000);
    for (int i = 0; i < files.size(); ++i) {
      const auto file = files[i];
      const auto sha = file.value(QStringLiteral("sha256")).toString();
      const auto identity = QStringLiteral("sha256:") + sha;
      const QJsonObject source{{QStringLiteral("id"), identity},
                               {QStringLiteral("kind"), QStringLiteral("direct")},
                               {QStringLiteral("identity"), identity},
                               {QStringLiteral("uri"), QStringLiteral("https://example.invalid/episode.mkv")},
                               {QStringLiteral("label"), QStringLiteral("Own copy")}};
      const QJsonObject video{{QStringLiteral("mediaId"), wp::RoomMedia::mediaId(identity, 0)},
                              {QStringLiteral("path"), QFileInfo(paths[i]).fileName()},
                              {QStringLiteral("label"), QStringLiteral("Episode %1").arg(i + 1)},
                              {QStringLiteral("fileIndex"), 0},
                              {QStringLiteral("size"), file.value(QStringLiteral("size"))},
                              {QStringLiteral("duration"), 12},
                              {QStringLiteral("selected"), true},
                              {QStringLiteral("sha256"), sha}};
      host.rooms.command(room, {{QStringLiteral("type"), QStringLiteral("queue.add")},
                                {QStringLiteral("source"), source},
                                {QStringLiteral("files"), QJsonArray{video}}});
      QTRY_COMPARE_WITH_TIMEOUT(host.rooms.room(room).value(QStringLiteral("entries")).toArray().size(),
                                i + 1, 5000);
    }
    const auto entries = host.rooms.room(room).value(QStringLiteral("entries")).toArray();
    const auto first = entries[0].toObject().value(QStringLiteral("id")).toString();
    const auto second = entries[1].toObject().value(QStringLiteral("id")).toString();
    host.playback.setRoom(room);
    guest.playback.setRoom(room);
    host.playback.joinWatch();
    QTRY_COMPARE_WITH_TIMEOUT(playback(guest, room).value(QStringLiteral("entryId")).toString(), first, 5000);
    guest.playback.joinWatch();
    QTRY_VERIFY_WITH_TIMEOUT(host.player.tracksKnown() && guest.player.tracksKnown(), 10000);
    QString embedded;
    for (auto value : host.player.tracks())
      if (value.toObject().value(QStringLiteral("type")).toString() == QStringLiteral("sub"))
        embedded = value.toObject().value(QStringLiteral("key")).toString();
    QVERIFY(!embedded.isEmpty());
    host.playback.setTracks(QStringLiteral("auto"), embedded, 0.75);
    QTRY_VERIFY_WITH_TIMEOUT(host.player.mediaInfo().value(QStringLiteral("subtitleId")).toInt(-1) > 0 &&
                                 guest.player.mediaInfo().value(QStringLiteral("subtitleId")).toInt(-1) > 0,
                             5000);
    host.playback.togglePause();
    QTRY_VERIFY_WITH_TIMEOUT(!playback(host, room).value(QStringLiteral("paused")).toBool(), 5000);
    QSignalSpy hostErrors(&host.playback, &wp::PlaybackController::error);
    QSignalSpy guestErrors(&guest.playback, &wp::PlaybackController::error);
    host.playback.choose(second);
    QTRY_VERIFY_WITH_TIMEOUT(host.player.loaded() && guest.player.loaded() &&
                                 host.playback.entryId() == second && guest.playback.entryId() == second,
                             10000);
    QTRY_COMPARE_WITH_TIMEOUT(host.playback.subtitleChoice(), QStringLiteral("off"), 5000);
    QTRY_COMPARE_WITH_TIMEOUT(guest.playback.subtitleChoice(), QStringLiteral("off"), 5000);
    QCOMPARE(host.playback.subtitleDelay(), 0);
    QCOMPARE(guest.playback.subtitleDelay(), 0);
    QTRY_COMPARE_WITH_TIMEOUT(nativeSubtitle(host.player), QStringLiteral("no"), 5000);
    QTRY_COMPARE_WITH_TIMEOUT(nativeSubtitle(guest.player), QStringLiteral("no"), 5000);
    QVERIFY(host.player.error().isEmpty());
    QVERIFY(guest.player.error().isEmpty());
    QCOMPARE(hostErrors.size(), 0);
    QCOMPARE(guestErrors.size(), 0);
    // A new explicit request during this episode must still explain a missing
    // shared track; episode-transition fallback must not erase that choice.
    host.playback.setTracks(QStringLiteral("auto"), embedded, 0.5);
    QTRY_COMPARE_WITH_TIMEOUT(guest.playback.subtitleChoice(), embedded, 5000);
    host.playback.togglePause();
    QTRY_VERIFY_WITH_TIMEOUT(playback(host, room)
                                 .value(QStringLiteral("reason"))
                                 .toString()
                                 .contains(QStringLiteral("subtitle track")),
                             5000);
    QTest::qWait(500);
    QCOMPARE(host.playback.subtitleChoice(), embedded);
    QVERIFY(playback(host, room).value(QStringLiteral("paused")).toBool());
    host.playback.setTracks(QStringLiteral("auto"), QStringLiteral("off"), 0);
    QTRY_VERIFY_WITH_TIMEOUT(!playback(host, room).value(QStringLiteral("paused")).toBool(), 5000);
    // Reopening the subtitle-bearing file must not restore its previous native
    // numeric ID while the room's current selection is off.
    host.playback.choose(first);
    QTRY_VERIFY_WITH_TIMEOUT(host.player.loaded() && guest.player.loaded() &&
                                 host.playback.entryId() == first && guest.playback.entryId() == first,
                             10000);
    // Unchanged native properties are not necessarily re-observed after open
    // clears mediaInfo, so inspect the actual current file's selection.
    QTRY_COMPARE_WITH_TIMEOUT(nativeSubtitle(host.player), QStringLiteral("no"), 5000);
    QTRY_COMPARE_WITH_TIMEOUT(nativeSubtitle(guest.player), QStringLiteral("no"), 5000);
    host.playback.setTracks(QStringLiteral("auto"), embedded, 0.25);
    QTRY_VERIFY_WITH_TIMEOUT(guest.player.mediaInfo().value(QStringLiteral("subtitleId")).toInt(-1) > 0,
                             5000);
    host.playback.togglePause();
    QTRY_VERIFY_WITH_TIMEOUT(!playback(host, room).value(QStringLiteral("paused")).toBool(), 5000);
    host.rooms.command(room, {{QStringLiteral("type"), QStringLiteral("playback.next")}});
    QTRY_VERIFY_WITH_TIMEOUT(host.playback.entryId() == second && guest.playback.entryId() == second &&
                                 host.playback.subtitleChoice() == QStringLiteral("off") &&
                                 guest.playback.subtitleChoice() == QStringLiteral("off") &&
                                 !playback(host, room).value(QStringLiteral("paused")).toBool(),
                             10000);
    QCOMPARE(hostErrors.size(), 0);
    QCOMPARE(guestErrors.size(), 0);
  }
  void restartingMembershipRequiresAnotherExplicitJoinButReconnectingDoesNot() {
    QTemporaryDir tmp;
    wp::test::Coordinator server;
    server.start(tmp.filePath(QStringLiteral("coordinator.sqlite")));
    const auto profile = tmp.filePath(QStringLiteral("device"));
    QString room, member;
    {
      wp::AppServices device(profile, nullptr, true, true);
      QSignalSpy created(&device.rooms, &wp::RoomClient::entered);
      device.rooms.create(server.url(), QStringLiteral("Explicit watch"), QStringLiteral("Host"));
      QTRY_COMPARE_WITH_TIMEOUT(created.size(), 1, 5000);
      room = created.first()[1].toString();
      QTRY_VERIFY_WITH_TIMEOUT(device.rooms.connected(room), 5000);
      member = device.rooms.credential(room).value(QStringLiteral("memberId")).toString();
      device.playback.setRoom(room);
      device.playback.joinWatch();
      QTRY_VERIFY_WITH_TIMEOUT(device.playback.joined(), 5000);
      device.rooms.reconnect(room);
      QTRY_VERIFY_WITH_TIMEOUT(device.rooms.connected(room) && device.playback.joined(), 5000);
      // Emulate process loss: do not call the graceful shutdown/leave action.
    }
    wp::AppServices restarted(profile, nullptr, true, true);
    restarted.restore();
    restarted.playback.setRoom(room);
    QTRY_VERIFY_WITH_TIMEOUT(restarted.rooms.connected(room), 5000);
    QVERIFY(!restarted.playback.joined());
    QTRY_COMPARE_WITH_TIMEOUT(watch(restarted, room, member), QStringLiteral("idle"), 5000);
    restarted.playback.joinWatch();
    QTRY_VERIFY_WITH_TIMEOUT(restarted.playback.joined(), 5000);
  }
  void eightActualPlayersStayWithinTheDriftBudgetAndRecoverFromARequiredDisconnect() {
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const auto original = tmp.filePath(QStringLiteral("eight.mp4"));
    QProcess fixture;
    fixture.start(QStringLiteral("ffmpeg"),
                  {QStringLiteral("-hide_banner"), QStringLiteral("-loglevel"), QStringLiteral("error"),
                   QStringLiteral("-f"), QStringLiteral("lavfi"), QStringLiteral("-i"),
                   QStringLiteral("testsrc2=size=320x180:rate=24:duration=30"), QStringLiteral("-c:v"),
                   QStringLiteral("libx264"), QStringLiteral("-preset"), QStringLiteral("ultrafast"),
                   QStringLiteral("-movflags"), QStringLiteral("+faststart"), original});
    QVERIFY(fixture.waitForFinished(30000));
    QCOMPARE(fixture.exitCode(), 0);
    wp::test::Coordinator server;
    server.start(tmp.filePath(QStringLiteral("coordinator.sqlite")));
    std::vector<std::unique_ptr<wp::AppServices>> devices;
    QStringList rooms;
    for (int i = 0; i < 8; ++i) {
      devices.emplace_back(std::make_unique<wp::AppServices>(tmp.filePath(QStringLiteral("device%1").arg(i)),
                                                             nullptr, true, true));
      sourceFile(*devices.back(), original);
    }
    auto &host = *devices[0];
    QSignalSpy created(&host.rooms, &wp::RoomClient::entered);
    host.rooms.create(server.url(), QStringLiteral("Eight watchers"), QStringLiteral("Host"));
    QTRY_COMPARE_WITH_TIMEOUT(created.size(), 1, 5000);
    rooms.append(created.first()[1].toString());
    QTRY_VERIFY_WITH_TIMEOUT(host.rooms.connected(rooms[0]), 5000);
    for (int i = 1; i < 8; ++i) {
      QSignalSpy joined(&devices[i]->rooms, &wp::RoomClient::entered);
      devices[i]->rooms.join(host.rooms.inviteLink(rooms[0]), QStringLiteral("Watcher %1").arg(i));
      QTRY_COMPARE_WITH_TIMEOUT(joined.size(), 1, 5000);
      rooms.append(joined.first()[1].toString());
      QTRY_VERIFY_WITH_TIMEOUT(devices[i]->rooms.connected(rooms[i]), 5000);
    }
    const auto file = host.library.files().first().toObject();
    const auto sha = file.value(QStringLiteral("sha256")).toString(),
               identity = QStringLiteral("sha256:") + sha;
    const QJsonObject source{{QStringLiteral("id"), identity},
                             {QStringLiteral("kind"), QStringLiteral("direct")},
                             {QStringLiteral("identity"), identity},
                             {QStringLiteral("uri"), QStringLiteral("https://example.invalid/eight.mp4")},
                             {QStringLiteral("label"), QStringLiteral("Own copies")}};
    const QJsonObject video{{QStringLiteral("mediaId"), wp::RoomMedia::mediaId(identity, 0)},
                            {QStringLiteral("path"), QStringLiteral("eight.mp4")},
                            {QStringLiteral("label"), QStringLiteral("Eight-player fixture")},
                            {QStringLiteral("fileIndex"), 0},
                            {QStringLiteral("size"), file.value(QStringLiteral("size"))},
                            {QStringLiteral("duration"), 30},
                            {QStringLiteral("selected"), true},
                            {QStringLiteral("sha256"), sha}};
    host.rooms.command(rooms[0], {{QStringLiteral("type"), QStringLiteral("queue.add")},
                                  {QStringLiteral("source"), source},
                                  {QStringLiteral("files"), QJsonArray{video}}});
    for (int i = 0; i < 8; ++i) {
      QTRY_COMPARE_WITH_TIMEOUT(
          devices[i]->rooms.room(rooms[i]).value(QStringLiteral("entries")).toArray().size(), 1, 5000);
      devices[i]->playback.setRoom(rooms[i]);
      devices[i]->playback.joinWatch();
    }
    auto allLoaded = [&] {
      for (const auto &d : devices)
        if (!d->player.loaded())
          return false;
      return true;
    };
    QTRY_VERIFY_WITH_TIMEOUT(allLoaded(), 15000);
    host.playback.togglePause();
    QTRY_VERIFY_WITH_TIMEOUT(!playback(host, rooms[0]).value(QStringLiteral("paused")).toBool(true) &&
                                 host.player.position() > 1,
                             10000);
    QList<double> spreads;
    QElapsedTimer sample;
    sample.start();
    while (sample.elapsed() < 3500) {
      QTest::qWait(50);
      double low = 1e9, high = 0;
      for (const auto &d : devices) {
        low = std::min(low, d->player.sampledPosition());
        high = std::max(high, d->player.sampledPosition());
      }
      spreads.append(high - low);
    }
    std::sort(spreads.begin(), spreads.end());
    const auto p95 = spreads[int(spreads.size() * .95)];
    qInfo("Eight actual libmpv players: native PTS spread p95 %.1f ms, maximum %.1f ms", p95 * 1000,
          spreads.last() * 1000);
    QVERIFY2(p95 <= .15,
             qPrintable(QStringLiteral("Eight-player native PTS p95 spread was %1 ms").arg(p95 * 1000)));
    host.playback.leaveWatch();
    QTRY_VERIFY_WITH_TIMEOUT(host.rooms.room(rooms[0]).value(QStringLiteral("reporterId")).toString() !=
                                 host.rooms.credential(rooms[0]).value(QStringLiteral("memberId")).toString(),
                             4000);
    const auto lost = devices[7]->rooms.credential(rooms[7]).value(QStringLiteral("memberId")).toString();
    QElapsedTimer detected;
    detected.start();
    devices[7]->rooms.shutdown();
    QTRY_VERIFY_WITH_TIMEOUT(playback(host, rooms[0]).value(QStringLiteral("paused")).toBool(), 1500);
    QVERIFY(detected.elapsed() < 1500);
    host.rooms.command(rooms[0], {{QStringLiteral("type"), QStringLiteral("watch.exclude")},
                                  {QStringLiteral("memberId"), lost}});
    QTRY_VERIFY_WITH_TIMEOUT(!playback(host, rooms[0]).value(QStringLiteral("paused")).toBool(true), 5000);
  }
  void actualPlayersHonorRoomBarriersAndHistory() {
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const auto original = tmp.filePath(QStringLiteral("episode.mp4"));
    QProcess ffmpeg;
    ffmpeg.start(QStringLiteral("ffmpeg"),
                 {QStringLiteral("-hide_banner"),
                  QStringLiteral("-loglevel"),
                  QStringLiteral("error"),
                  QStringLiteral("-f"),
                  QStringLiteral("lavfi"),
                  QStringLiteral("-i"),
                  QStringLiteral("testsrc2=size=320x180:rate=24:duration=24"),
                  QStringLiteral("-f"),
                  QStringLiteral("lavfi"),
                  QStringLiteral("-i"),
                  QStringLiteral("sine=frequency=440:sample_rate=48000:duration=24"),
                  QStringLiteral("-c:v"),
                  QStringLiteral("libx264"),
                  QStringLiteral("-preset"),
                  QStringLiteral("ultrafast"),
                  QStringLiteral("-c:a"),
                  QStringLiteral("aac"),
                  QStringLiteral("-movflags"),
                  QStringLiteral("+faststart"),
                  original});
    QVERIFY(ffmpeg.waitForFinished(30000));
    QCOMPARE(ffmpeg.exitCode(), 0);
    wp::test::Coordinator server;
    server.start(tmp.filePath(QStringLiteral("server.sqlite")));
    wp::AppServices host(tmp.filePath(QStringLiteral("host")), nullptr, true, true),
        guest(tmp.filePath(QStringLiteral("guest")), nullptr, true, true);
    const auto guestPath = tmp.filePath(QStringLiteral("guest-copy.mp4"));
    QVERIFY(QFile::copy(original, guestPath));
    const auto file = sourceFile(host, original);
    sourceFile(guest, guestPath);
    QSignalSpy entered(&host.rooms, &wp::RoomClient::entered);
    host.rooms.create(server.url(), QStringLiteral("Player room"), QStringLiteral("Host"));
    QTRY_COMPARE_WITH_TIMEOUT(entered.size(), 1, 5000);
    const auto room = entered.first()[1].toString();
    QTRY_VERIFY_WITH_TIMEOUT(host.rooms.connected(room), 5000);
    const auto sha = file.value(QStringLiteral("sha256")).toString(),
               identity = QStringLiteral("sha256:") + sha;
    const QJsonObject source{{QStringLiteral("id"), identity},
                             {QStringLiteral("kind"), QStringLiteral("direct")},
                             {QStringLiteral("label"), QStringLiteral("Own copy")},
                             {QStringLiteral("uri"), QStringLiteral("https://example.invalid/episode.mp4")},
                             {QStringLiteral("identity"), identity}};
    const QJsonObject descriptor{{QStringLiteral("mediaId"), wp::RoomMedia::mediaId(identity, 0)},
                                 {QStringLiteral("path"), QStringLiteral("episode.mp4")},
                                 {QStringLiteral("label"), QStringLiteral("Episode 1")},
                                 {QStringLiteral("fileIndex"), 0},
                                 {QStringLiteral("size"), file.value(QStringLiteral("size"))},
                                 {QStringLiteral("duration"), QJsonValue::Null},
                                 {QStringLiteral("selected"), true},
                                 {QStringLiteral("sha256"), sha}};
    host.rooms.command(room, {{QStringLiteral("type"), QStringLiteral("queue.add")},
                              {QStringLiteral("source"), source},
                              {QStringLiteral("files"), QJsonArray{descriptor}}});
    QTRY_COMPARE_WITH_TIMEOUT(host.rooms.room(room).value(QStringLiteral("entries")).toArray().size(), 1,
                              5000);
    const auto entry = host.rooms.room(room)
                           .value(QStringLiteral("entries"))
                           .toArray()
                           .first()
                           .toObject()
                           .value(QStringLiteral("id"))
                           .toString();
    QSignalSpy joined(&guest.rooms, &wp::RoomClient::entered);
    guest.rooms.join(host.rooms.inviteLink(room), QStringLiteral("Guest"));
    QTRY_COMPARE_WITH_TIMEOUT(joined.size(), 1, 5000);
    const auto guestRoom = joined.first()[1].toString();
    QTRY_VERIFY_WITH_TIMEOUT(guest.rooms.connected(guestRoom), 5000);
    host.playback.setRoom(room);
    guest.playback.setRoom(guestRoom);
    QTest::qWait(300);
    QVERIFY(!host.player.loaded());
    QVERIFY(!guest.player.loaded());
    host.playback.joinWatch();
    guest.playback.joinWatch();
    QTRY_VERIFY_WITH_TIMEOUT(host.player.loaded() && guest.player.loaded(), 12000);
    const auto guestMember = guest.rooms.credential(guestRoom).value(QStringLiteral("memberId")).toString();
    QTRY_COMPARE_WITH_TIMEOUT(watch(host, room, guestMember), QStringLiteral("active"), 10000);
    const auto subtitlePath = tmp.filePath(QStringLiteral("shared.srt"));
    QFile subtitle(subtitlePath);
    QVERIFY(subtitle.open(QIODevice::WriteOnly));
    subtitle.write("1\n00:00:00,000 --> 00:00:23,000\nShared subtitle test\n");
    subtitle.close();
    QSignalSpy subtitlePrepared(&host.sharing, &wp::SharingService::prepared);
    host.sharing.prepare(subtitlePath, room);
    QTRY_COMPARE_WITH_TIMEOUT(subtitlePrepared.size(), 1, 5000);
    const auto subtitleBundle = subtitlePrepared.first()[0].toJsonObject();
    const auto subtitleKey = QStringLiteral("ext:") + subtitleBundle.value(QStringLiteral("assets"))
                                                          .toArray()
                                                          .first()
                                                          .toObject()
                                                          .value(QStringLiteral("sha256"))
                                                          .toString();
    host.sharing.publishSubtitle(subtitleBundle.value(QStringLiteral("id")).toString(), room, 0,
                                 playback(host, room).value(QStringLiteral("generation")).toInt());
    auto hasSubtitle = [&](wp::Player &player) {
      for (auto value : player.tracks())
        if (value.toObject().value(QStringLiteral("key")).toString() == subtitleKey)
          return true;
      return false;
    };
    QTRY_COMPARE_WITH_TIMEOUT(playback(host, room).value(QStringLiteral("subtitle")).toString(), subtitleKey,
                              5000);
    QTRY_VERIFY_WITH_TIMEOUT(hasSubtitle(host.player) && hasSubtitle(guest.player), 15000);
    host.playback.setRate(3);
    QTRY_COMPARE_WITH_TIMEOUT(playback(host, room).value(QStringLiteral("rate")).toInt(), 3, 5000);
    guest.playback.togglePause();
    QTRY_VERIFY_WITH_TIMEOUT(!playback(host, room).value(QStringLiteral("paused")).toBool(true), 5000);
    QTRY_VERIFY_WITH_TIMEOUT(host.player.position() > 1 && guest.player.position() > 1, 5000);
    QVERIFY(std::abs(host.player.position() - guest.player.position()) < .65);
    guest.player.stop();
    QTRY_VERIFY_WITH_TIMEOUT(playback(host, room).value(QStringLiteral("paused")).toBool(), 3000);
    // Canceling requested playback while buffering must prevent auto-resume.
    host.playback.togglePause();
    QTRY_VERIFY_WITH_TIMEOUT(!playback(host, room).value(QStringLiteral("requested")).toBool(), 3000);
    guest.playback.retry();
    QTRY_VERIFY_WITH_TIMEOUT(guest.player.loaded(), 6000);
    QTest::qWait(500);
    QVERIFY(playback(host, room).value(QStringLiteral("paused")).toBool());
    host.playback.setTracks(QStringLiteral("not-present"), QStringLiteral("off"), 0);
    QTRY_COMPARE_WITH_TIMEOUT(playback(host, room).value(QStringLiteral("audio")).toString(),
                              QStringLiteral("not-present"), 3000);
    QTRY_VERIFY_WITH_TIMEOUT(host.playback.reason().contains(QStringLiteral("unavailable")) &&
                                 guest.playback.reason().contains(QStringLiteral("unavailable")),
                             5000);
    guest.playback.setTracks(QStringLiteral("auto"), QStringLiteral("off"), 0);
    QTRY_VERIFY_WITH_TIMEOUT(host.playback.reason().isEmpty() && guest.playback.reason().isEmpty(), 6000);
    // Seeking over unwatched time does not count it as viewing coverage.
    host.playback.seek(20);
    QTRY_VERIFY_WITH_TIMEOUT(
        std::abs(host.player.position() - 20) < .8 && std::abs(guest.player.position() - 20) < .8, 5000);
    QVERIFY(host.rooms.entry(room, entry).value(QStringLiteral("watchedAt")).isNull());
    host.playback.seek(0);
    QTRY_VERIFY_WITH_TIMEOUT(host.player.position() < .8 && guest.player.position() < .8, 5000);
    host.playback.togglePause();
    QTRY_VERIFY_WITH_TIMEOUT(!playback(host, room).value(QStringLiteral("paused")).toBool(true), 5000);
    QTRY_VERIFY2_WITH_TIMEOUT(
        !host.rooms.entry(room, entry).value(QStringLiteral("watchedAt")).isNull(),
        qPrintable(QString::fromUtf8(
            QJsonDocument(
                QJsonObject{
                    {QStringLiteral("coverage"),
                     server.inspect(host.rooms.credential(room).value(QStringLiteral("roomId")).toString())},
                    {QStringLiteral("host"), host.playback.diagnostics()},
                    {QStringLiteral("guest"), guest.playback.diagnostics()},
                    {QStringLiteral("timeline"), playback(host, room)}})
                .toJson(QJsonDocument::Compact))),
        18000);
    QCOMPARE(playback(host, room).value(QStringLiteral("entryId")).toString(), entry);
    QVERIFY(host.rooms.entry(room, entry).value(QStringLiteral("enabled")).toBool());
    QVERIFY(host.player.loaded());
    host.rooms.command(room, {{QStringLiteral("type"), QStringLiteral("history.mark")},
                              {QStringLiteral("ids"), QJsonArray{entry}},
                              {QStringLiteral("watched"), false}});
    QTRY_VERIFY_WITH_TIMEOUT(host.rooms.entry(room, entry).value(QStringLiteral("watchedAt")).isNull(), 3000);
    // Explicitly unselecting the current episode stops both players.
    host.rooms.command(room, {{QStringLiteral("type"), QStringLiteral("queue.select")},
                              {QStringLiteral("sourceId"), identity},
                              {QStringLiteral("mediaIds"), QJsonArray()}});
    QTRY_VERIFY_WITH_TIMEOUT(playback(host, room).value(QStringLiteral("entryId")).isNull(), 5000);
    QTRY_VERIFY_WITH_TIMEOUT(!host.player.loaded() && !guest.player.loaded(), 3000);
    QVERIFY(host.direct.downloads().isEmpty());
    QVERIFY(guest.direct.downloads().isEmpty());
  }
};
int main(int argc, char **argv) {
  QCoreApplication app(argc, argv);
  wp::configureNativeRuntime();
  PlaybackTests tests;
  return QTest::qExec(&tests, argc, argv);
}
#include "playback_tests.moc"
