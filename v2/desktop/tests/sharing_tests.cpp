#include "app_services.h"
#include "coordinator_fixture.h"
#include "native_runtime.h"
#include <QFile>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QTemporaryDir>
#include <QtTest>
namespace {
void write(const QString &path, const QByteArray &data) {
  QDir().mkpath(QFileInfo(path).absolutePath());
  QFile f(path);
  if (!f.open(QIODevice::WriteOnly) || f.write(data) != data.size())
    throw std::runtime_error("Fixture write failed");
}
QJsonObject firstEntry(wp::AppServices &app, const QString &room) {
  for (auto value : app.rooms.room(room).value(QStringLiteral("entries")).toArray())
    if (value.toObject().value(QStringLiteral("enabled")).toBool())
      return value.toObject();
  return {};
}
} // namespace
class SharingTests final : public QObject {
  Q_OBJECT
private slots:
  void authenticatedEncryptionAndOddMerkleProofs() {
    const auto a = wp::sharing::random(32), b = wp::sharing::random(32),
               context =
                   wp::sharing::context(QStringLiteral("room"), QStringLiteral("a"), QStringLiteral("b"));
    const auto key = wp::sharing::deriveKey(a, wp::sharing::publicKey(b), context);
    QCOMPARE(key, wp::sharing::deriveKey(b, wp::sharing::publicKey(a), context));
    const auto plain = QByteArray("private media bytes"), cipher = wp::sharing::seal(key, plain, context);
    QVERIFY(!cipher.contains(plain));
    QCOMPARE(wp::sharing::open(key, cipher, context), plain);
    auto corrupt = cipher;
    corrupt[15] = char(corrupt[15] ^ 1);
    QVERIFY_EXCEPTION_THROWN(wp::sharing::open(key, corrupt, context), wp::AppError);
    QVERIFY_EXCEPTION_THROWN(wp::sharing::open(key, cipher, context + "other-room"), wp::AppError);
    QList<QByteArray> data{QByteArray("one"), QByteArray("two"), QByteArray("three"), QByteArray("four"),
                           QByteArray("five")},
        hashes;
    for (const auto &d : data)
      hashes.append(wp::sharing::leaf(d));
    const auto root = wp::sharing::root(hashes);
    for (int i = 0; i < data.size(); ++i) {
      const auto proof = wp::sharing::proof(hashes, i);
      QVERIFY(wp::sharing::verify(data[i], i, data.size(), proof, root));
      QVERIFY(!wp::sharing::verify(data[i] + "corrupt", i, data.size(), proof, root));
      QVERIFY(!wp::sharing::verify(data[i], (i + 1) % data.size(), data.size(), proof, root));
    }
  }
  void privateCopiesAndVerifiedProgressiveReads_data() {
    QTest::addColumn<bool>("relay");
    QTest::newRow("direct") << false;
    QTest::newRow("relay") << true;
  }
  void privateCopiesAndVerifiedProgressiveReads() {
    QFETCH(bool, relay);
    try {
      QTemporaryDir tmp;
      QVERIFY(tmp.isValid());
      const auto root = tmp.filePath(QStringLiteral("source"));
      const QByteArray original =
          wp::sharing::random(512).repeated(8192) + QByteArray("the final verified bytes");
      write(root + QStringLiteral("/Season 1/E01.mkv"), original);
      write(root + QStringLiteral("/Season 2/E02.mp4"), QByteArray(1024, 'b'));
      write(root + QStringLiteral("/Extras/Sample.mkv"), QByteArray(1024, 'x'));
      write(root + QStringLiteral("/Season 1/E01.srt"),
            QByteArray("1\n00:00:01,000 --> 00:00:02,000\nSubtitles\n"));
      wp::test::Coordinator server;
      server.start(tmp.filePath(QStringLiteral("server.sqlite")));
      wp::AppServices host(tmp.filePath(QStringLiteral("host")), nullptr, true, true);
      const auto guestProfile = tmp.filePath(QStringLiteral("guest"));
      auto guest = std::make_unique<wp::AppServices>(guestProfile, nullptr, true, true);
      host.store.setSetting(QStringLiteral("preferRelay"), relay);
      guest->store.setSetting(QStringLiteral("preferRelay"), relay);
      host.transfers.configure({{QStringLiteral("reserveMiB"), 0}, {QStringLiteral("upLimit"), 1024 * 1024}});
      guest->transfers.configure(
          {{QStringLiteral("reserveMiB"), 0}, {QStringLiteral("downLimit"), 1024 * 1024}});
      QSignalSpy entered(&host.rooms, &wp::RoomClient::entered);
      host.rooms.create(server.url(), QStringLiteral("Share room"), QStringLiteral("Host"));
      QTRY_COMPARE_WITH_TIMEOUT(entered.size(), 1, 5000);
      const auto room = entered.first()[1].toString();
      QTRY_VERIFY_WITH_TIMEOUT(host.rooms.connected(room), 5000);
      QSignalSpy join(&guest->rooms, &wp::RoomClient::entered);
      guest->rooms.join(host.rooms.inviteLink(room), QStringLiteral("Guest"));
      QTRY_COMPARE_WITH_TIMEOUT(join.size(), 1, 5000);
      const auto guestRoom = join.first()[1].toString();
      QTRY_VERIFY_WITH_TIMEOUT(guest->rooms.connected(guestRoom), 5000);
      QSignalSpy prepared(&host.sharing, &wp::SharingService::prepared);
      host.sharing.prepare(root, room);
      QTRY_COMPARE_WITH_TIMEOUT(prepared.size(), 1, 5000);
      const auto bundle = prepared.first()[0].toJsonObject();
      QCOMPARE(bundle.value(QStringLiteral("assets")).toArray().size(), 4);
      int first = -1;
      for (auto value : bundle.value(QStringLiteral("files")).toArray())
        if (value.toObject().value(QStringLiteral("relative")).toString().contains(QStringLiteral("E01.mkv")))
          first = value.toObject().value(QStringLiteral("index")).toInt();
      QVERIFY(first >= 0);
      host.sharing.publish(bundle.value(QStringLiteral("id")).toString(), room, {first});
      QTRY_COMPARE_WITH_TIMEOUT(
          guest->rooms.room(guestRoom).value(QStringLiteral("entries")).toArray().size(), 3, 5000);
      const auto entry = firstEntry(*guest, guestRoom);
      QVERIFY(!entry.isEmpty());
      QTest::qWait(500);
      QVERIFY(guest->sharing.downloads().isEmpty());
      guest->media.approve(guestRoom, entry.value(QStringLiteral("sourceId")).toString(),
                           {entry.value(QStringLiteral("mediaId")).toString()});
      QTRY_COMPARE_WITH_TIMEOUT(guest->sharing.downloads().size(), 1, 8000);
      auto binding = guest->media.binding(guestRoom, entry.value(QStringLiteral("id")).toString());
      QVERIFY(binding.source);
      binding.source->requestPiece(4, -1);
      QTRY_VERIFY_WITH_TIMEOUT(binding.source->hasPiece(4), 20000);
      QVERIFY(!binding.source->hasPiece(2));
      const auto download =
          guest->sharing.downloads().first().toObject().value(QStringLiteral("id")).toString();
      const auto hostMember = host.rooms.credential(room).value(QStringLiteral("memberId")).toString();
      QTRY_VERIFY_WITH_TIMEOUT(guest->sharing.transport()
                                   .mode(guestRoom, hostMember)
                                   .contains(relay ? QStringLiteral("Relay") : QStringLiteral("Direct")),
                               10000);
      {
        wp::VerifiedStream stream(*binding.source);
        QNetworkAccessManager network;
        QNetworkRequest request(stream.url(0));
        request.setRawHeader("Range",
                             QByteArray("bytes=") + QByteArray::number(4 * wp::sharing::ChunkSize) + "-");
        auto *reply = network.get(request);
        QSignalSpy finished(reply, &QNetworkReply::finished);
        QTRY_COMPARE_WITH_TIMEOUT(finished.size(), 1, 5000);
        QCOMPARE(reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 206);
        QCOMPARE(reply->readAll(), original.mid(4 * wp::sharing::ChunkSize));
        reply->deleteLater();
        QVERIFY_EXCEPTION_THROWN(guest->sharing.remove(download, true), wp::AppError);
      }
      guest->sharing.pause(download);
      QTest::qWait(500);
      QVERIFY(guest->sharing.downloads().first().toObject().value(QStringLiteral("manualPaused")).toBool());
      guest.reset();
      guest = std::make_unique<wp::AppServices>(guestProfile, nullptr, true, true);
      guest->restore();
      QTRY_VERIFY_WITH_TIMEOUT(guest->rooms.connected(guestRoom), 8000);
      QTest::qWait(500);
      QVERIFY(guest->sharing.downloads().first().toObject().value(QStringLiteral("manualPaused")).toBool());
      guest->sharing.resume(download);
      QTRY_VERIFY2_WITH_TIMEOUT(
          guest->sharing.downloads().first().toObject().value(QStringLiteral("state")).toString() ==
              QStringLiteral("Ready"),
          qPrintable(QString::fromUtf8(
              QJsonDocument(QJsonObject{{QStringLiteral("downloads"), guest->sharing.downloads()},
                                        {QStringLiteral("mode"),
                                         guest->sharing.transport().mode(guestRoom, hostMember)},
                                        {QStringLiteral("guestEvents"), guest->activity()},
                                        {QStringLiteral("hostEvents"), host.activity()}})
                  .toJson(QJsonDocument::Compact))),
          30000);
      const auto copy = guest->sharing.downloads().first().toObject();
      QFile file(copy.value(QStringLiteral("path")).toString());
      QVERIFY(file.open(QIODevice::ReadOnly));
      QCOMPARE(file.readAll(), original);
      file.close();
      guest->sharing.pin(download, true);
      QVERIFY_EXCEPTION_THROWN(guest->sharing.remove(download, true), wp::AppError);
      guest->sharing.pin(download, false);
      const auto unrelated = copy.value(QStringLiteral("root")).toString() + QStringLiteral("/keep-me.txt");
      write(unrelated, QByteArray("unrelated"));
      guest->sharing.remove(download, true);
      QVERIFY(QFileInfo::exists(unrelated));
      QVERIFY(!QFileInfo::exists(copy.value(QStringLiteral("path")).toString()));
      QFile publisher(root + QStringLiteral("/Season 1/E01.mkv"));
      QVERIFY(publisher.open(QIODevice::ReadOnly));
      QCOMPARE(publisher.readAll(), original);
    } catch (const std::exception &e) {
      QFAIL(e.what());
    }
  }
};
int main(int argc, char **argv) {
  QCoreApplication app(argc, argv);
  wp::configureNativeRuntime();
  SharingTests tests;
  return QTest::qExec(&tests, argc, argv);
}
#include "sharing_tests.moc"
