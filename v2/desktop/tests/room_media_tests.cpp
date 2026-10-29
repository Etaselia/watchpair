#include "../../testing/torrent_fixture.h"
#include "coordinator_fixture.h"
#include "native_runtime.h"
#include "room_media.h"
#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QTemporaryDir>
#include <QUuid>
#include <QtTest>
#include <libtorrent/add_torrent_params.hpp>
#include <libtorrent/bencode.hpp>
#include <libtorrent/create_torrent.hpp>
#include <libtorrent/settings_pack.hpp>
#include <libtorrent/torrent_info.hpp>
namespace lt = libtorrent;
namespace {
void write(const QString &path, const QByteArray &bytes) {
  QDir().mkpath(QFileInfo(path).path());
  QFile file(path);
  if (!file.open(QIODevice::WriteOnly) || file.write(bytes) != bytes.size())
    throw std::runtime_error("Fixture write failed");
}
QString fixture(const QString &root) {
  write(root + QStringLiteral("/Pack/S01/E01.mkv"), QByteArray(512 * 1024, 'a'));
  write(root + QStringLiteral("/Pack/S02/E02.mkv"), QByteArray(768 * 1024, 'b'));
  write(root + QStringLiteral("/Pack/Bonus/Sample.mkv"), QByteArray(16385, 'x'));
  lt::file_storage fs;
  lt::add_files(fs, (root + QStringLiteral("/Pack")).toStdString());
  lt::create_torrent create(fs, 64 * 1024, lt::create_torrent::v1_only);
  wp::test::setV1Hashes(create, fs, root);
  std::vector<char> bytes;
  lt::bencode(std::back_inserter(bytes), create.generate());
  const auto path = root + QStringLiteral("/pack.torrent");
  write(path, QByteArray(bytes.data(), bytes.size()));
  return path;
}
struct Device {
  wp::LocalStore store;
  wp::TransferEngine transfers;
  wp::LibraryService library;
  wp::DirectDownloads direct;
  wp::SourceResolver resolver;
  wp::RoomClient rooms;
  std::unique_ptr<wp::RoomMedia> media;
  explicit Device(const QString &profile)
      : store(profile), transfers(store, nullptr, true), library(store), direct(store, library, transfers),
        resolver(store), rooms(store),
        media(std::make_unique<wp::RoomMedia>(store, rooms, transfers, resolver, library, direct)) {
    transfers.configure({{QStringLiteral("reserveMiB"), 0}});
  }
};
} // namespace
class RoomMediaTests final : public QObject {
  Q_OBJECT
private slots:
  void packSelectionUsesOriginalIndexesAndReusesExactLocalCopy() {
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const auto seedRoot = tmp.path() + QStringLiteral("/seed");
    const auto torrent = fixture(seedRoot);
    wp::test::Coordinator server;
    server.start(tmp.path() + QStringLiteral("/server.sqlite"));
    Device host(tmp.path() + QStringLiteral("/host")), guest(tmp.path() + QStringLiteral("/guest"));
    QSignalSpy entered(&host.rooms, &wp::RoomClient::entered);
    host.rooms.create(server.url(), QStringLiteral("Pack room"), QStringLiteral("Host"));
    QTRY_COMPARE_WITH_TIMEOUT(entered.size(), 1, 5000);
    const auto room = entered.first()[1].toString();
    QTRY_VERIFY_WITH_TIMEOUT(host.rooms.connected(room), 5000);
    QSignalSpy prepared(host.media.get(), &wp::RoomMedia::prepared);
    host.media->prepare(torrent, room);
    QTRY_COMPARE_WITH_TIMEOUT(prepared.size(), 1, 5000);
    const auto transfer = prepared.first()[0].toJsonObject().value(QStringLiteral("transfer")).toString();
    auto *hostSource = host.transfers.source(transfer);
    QVERIFY(hostSource);
    int first = -1, second = -1;
    for (const auto &file : hostSource->files()) {
      QVERIFY(!hostSource->selected(file.index));
      if (file.path.contains(QStringLiteral("S01")))
        first = file.index;
      if (file.path.contains(QStringLiteral("S02")))
        second = file.index;
    }
    QVERIFY(first >= 0 && second >= 0);
    host.media->publishTorrent(transfer, room, {second}, true, true);
    QTRY_VERIFY_WITH_TIMEOUT(hostSource->selected(second), 5000);
    QVERIFY(!hostSource->selected(first));
    QTRY_VERIFY_WITH_TIMEOUT(host.store.all(QStringLiteral("publication")).isEmpty(), 5000);
    QTRY_COMPARE_WITH_TIMEOUT(host.rooms.room(room).value(QStringLiteral("entries")).toArray().size(), 3,
                              5000);
    const auto sourceId = host.transfers.view(transfer).identity;
    QJsonObject episode;
    for (auto value : host.rooms.room(room).value(QStringLiteral("entries")).toArray())
      if (value.toObject().value(QStringLiteral("fileIndex")).toInt() == second)
        episode = value.toObject();
    QVERIFY(!episode.isEmpty());
    QCOMPARE(episode.value(QStringLiteral("mediaId")).toString(), wp::RoomMedia::mediaId(sourceId, second));
    QSignalSpy joined(&guest.rooms, &wp::RoomClient::entered);
    guest.rooms.join(host.rooms.inviteLink(room), QStringLiteral("Guest"));
    QTRY_COMPARE_WITH_TIMEOUT(joined.size(), 1, 5000);
    const auto guestRoom = joined.first()[1].toString();
    QTRY_VERIFY_WITH_TIMEOUT(guest.rooms.connected(guestRoom), 5000);
    QTRY_COMPARE_WITH_TIMEOUT(guest.transfers.transfers().size(), 1, 5000);
    const auto guestTransfer = guest.transfers.transfers().first().id;
    QTimer metadataPeers;
    connect(&metadataPeers, &QTimer::timeout, this, [&] {
      guest.transfers.connectPeer(guestTransfer, QStringLiteral("127.0.0.1"), host.transfers.port());
    });
    metadataPeers.start(200);
    QTRY_COMPARE_WITH_TIMEOUT(guest.transfers.source(guestTransfer)->files().size(), 3, 15000);
    QVERIFY(!guest.transfers.source(guestTransfer)->selected(second));
    QCOMPARE(guest.media->policy(guestRoom), QStringLiteral("Ask"));
    auto wrong = episode;
    wrong.insert(QStringLiteral("path"), QStringLiteral("Wrong/episode.mkv"));
    wrong.insert(QStringLiteral("selected"), true);
    wrong.remove(QStringLiteral("id"));
    wrong.remove(QStringLiteral("sourceId"));
    wrong.remove(QStringLiteral("enabled"));
    wrong.remove(QStringLiteral("watchedAt"));
    wrong.remove(QStringLiteral("viewingId"));
    wrong.remove(QStringLiteral("coverageSeconds"));
    const QJsonObject badSource{{QStringLiteral("id"), QStringLiteral("bad-source")},
                                {QStringLiteral("kind"), QStringLiteral("torrent")},
                                {QStringLiteral("label"), QStringLiteral("Mismatched manifest")},
                                {QStringLiteral("identity"), sourceId},
                                {QStringLiteral("uri"), host.transfers.magnet(transfer)}};
    guest.rooms.command(guestRoom, {{QStringLiteral("type"), QStringLiteral("queue.add")},
                                    {QStringLiteral("source"), badSource},
                                    {QStringLiteral("files"), QJsonArray{wrong}}});
    QTRY_COMPARE_WITH_TIMEOUT(guest.rooms.room(guestRoom).value(QStringLiteral("sources")).toArray().size(),
                              2, 5000);
    guest.media->approve(guestRoom, QStringLiteral("bad-source"),
                         {episode.value(QStringLiteral("mediaId")).toString()});
    QTest::qWait(100);
    QVERIFY(!guest.transfers.source(guestTransfer)->selected(second));
    QString badEntry;
    for (auto value : guest.rooms.room(guestRoom).value(QStringLiteral("entries")).toArray())
      if (value.toObject().value(QStringLiteral("sourceId")).toString() == QStringLiteral("bad-source"))
        badEntry = value.toObject().value(QStringLiteral("id")).toString();
    QVERIFY(!badEntry.isEmpty());
    QVERIFY(guest.media->binding(guestRoom, badEntry).reason.contains(QStringLiteral("manifest")));
    const auto existingPath = tmp.path() + QStringLiteral("/guest-library/exact-copy.mkv");
    write(existingPath, QByteArray(768 * 1024, 'b'));
    QSignalSpy identified(&guest.library, &wp::LibraryService::identified);
    guest.library.identify(existingPath);
    QTRY_COMPARE_WITH_TIMEOUT(identified.size(), 1, 5000);
    lt::settings_pack config;
    config.set_str(lt::settings_pack::listen_interfaces, wp::torrentListenInterface(true));
    config.set_bool(lt::settings_pack::enable_dht, false);
    config.set_bool(lt::settings_pack::enable_lsd, false);
    config.set_bool(lt::settings_pack::enable_upnp, false);
    config.set_bool(lt::settings_pack::enable_natpmp, false);
    config.set_bool(lt::settings_pack::close_redundant_connections, false);
    lt::session seeder(config);
    lt::add_torrent_params p;
    p.ti = std::make_shared<lt::torrent_info>(torrent.toStdString());
    p.save_path = seedRoot.toStdString();
    p.flags &= ~lt::torrent_flags::paused;
    p.flags &= ~lt::torrent_flags::auto_managed;
    p.flags |= lt::torrent_flags::seed_mode;
    auto seed = seeder.add_torrent(p);
    QTRY_VERIFY_WITH_TIMEOUT(seeder.listen_port() > 0 && seed.status().is_seeding, 5000);
    QTimer payloadPeer;
    connect(&payloadPeer, &QTimer::timeout, this,
            [&] { host.transfers.connectPeer(transfer, QStringLiteral("127.0.0.1"), seeder.listen_port()); });
    payloadPeer.start(200);
    const auto expectedSha = QString::fromLatin1(
        QCryptographicHash::hash(QByteArray(768 * 1024, 'b'), QCryptographicHash::Sha256).toHex());
    const auto entryId = episode.value(QStringLiteral("id")).toString();
    QTRY_COMPARE_WITH_TIMEOUT(
        guest.rooms.entry(guestRoom, entryId).value(QStringLiteral("sha256")).toString(), expectedSha, 30000);
    const auto reused = guest.media->binding(guestRoom, entryId);
    QVERIFY(reused.source);
    QVERIFY(dynamic_cast<wp::LocalFileSource *>(reused.source.data()));
    QCOMPARE(reused.path, QFileInfo(existingPath).canonicalFilePath());
    QVERIFY(!guest.transfers.source(guestTransfer)->selected(second));
    QVERIFY(
        !QFileInfo::exists(guest.transfers.view(guestTransfer).path + QStringLiteral("/Pack/S02/E02.mkv")));
    QVERIFY(server.dropNextAck());
    host.media->publishTorrent(transfer, room, {first}, true, true);
    host.transfers.select(transfer, {});
    QTRY_VERIFY_WITH_TIMEOUT(host.store.all(QStringLiteral("publication")).isEmpty(), 10000);
    QVERIFY(!hostSource->selected(first));
    QVERIFY(!hostSource->selected(second));
    // Simulate a crash after an accepted local intent transaction, but before
    // that transaction has been applied to the native session.
    auto native = host.transfers.intent(transfer);
    native.insert(QStringLiteral("overrides"), QJsonObject{{QString::number(first), 4}});
    host.store.put(QStringLiteral("transfer"), transfer, native);
    const auto recovery = QUuid::createUuid().toString(QUuid::WithoutBraces);
    host.store.put(QStringLiteral("publication"), recovery,
                   {{QStringLiteral("id"), recovery},
                    {QStringLiteral("room"), room},
                    {QStringLiteral("binding"), room + QLatin1Char(':') + sourceId},
                    {QStringLiteral("transfer"), transfer},
                    {QStringLiteral("state"), QStringLiteral("accepted")}});
    host.media.reset();
    host.media = std::make_unique<wp::RoomMedia>(host.store, host.rooms, host.transfers, host.resolver,
                                                 host.library, host.direct);
    QTRY_VERIFY_WITH_TIMEOUT(hostSource->selected(first), 5000);
    QTRY_VERIFY_WITH_TIMEOUT(host.store.all(QStringLiteral("publication")).isEmpty(), 5000);
    payloadPeer.stop();
    host.transfers.setPlayback({}, -1);
    host.transfers.setPaused(transfer, true);
    QTRY_VERIFY_WITH_TIMEOUT(!host.transfers.view(transfer).inUse, 5000);
    host.transfers.setPinned(transfer, false);
    host.transfers.remove(transfer);
    QTRY_VERIFY_WITH_TIMEOUT(!host.transfers.source(transfer), 5000);
    const int count = host.transfers.transfers().size();
    QTest::qWait(1000);
    QCOMPARE(host.transfers.transfers().size(), count);
    QVERIFY(host.media->acquisition(room, sourceId).value(QStringLiteral("effectivePolicy")).toString() ==
            QStringLiteral("Never"));
  }
};
int main(int argc, char **argv) {
  QCoreApplication app(argc, argv);
  wp::configureNativeRuntime();
  RoomMediaTests tests;
  return QTest::qExec(&tests, argc, argv);
}
#include "room_media_tests.moc"
