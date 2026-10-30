#include "../../testing/torrent_fixture.h"
#include "app_services.h"
#include "direct_download.h"
#include "library_service.h"
#include "lifecycle.h"
#include "local_store.h"
#include "native_runtime.h"
#include "owned_storage.h"
#include "source_resolver.h"
#include "transfer_engine.h"
#include "verified_stream.h"
#include <QCryptographicHash>
#include <QJsonDocument>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QSaveFile>
#include <QSqlQuery>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTemporaryDir>
#include <QtConcurrent>
#include <QtTest>
#include <libtorrent/add_torrent_params.hpp>
#include <libtorrent/bencode.hpp>
#include <libtorrent/create_torrent.hpp>
#include <libtorrent/hasher.hpp>
#include <libtorrent/read_resume_data.hpp>
#include <libtorrent/settings_pack.hpp>
#include <libtorrent/torrent_info.hpp>
#include <libtorrent/write_resume_data.hpp>

namespace lt = libtorrent;
namespace {
void write(const QString &path, const QByteArray &bytes) {
  QDir().mkpath(QFileInfo(path).path());
  QFile f(path);
  if (!f.open(QIODevice::WriteOnly) || f.write(bytes) != bytes.size())
    throw std::runtime_error("Fixture write failed");
}
QString torrent(const QString &root, const QString &name) {
  write(root + QLatin1Char('/') + name + QStringLiteral("/S01/E01.mkv"), QByteArray(768 * 1024, 'A'));
  write(root + QLatin1Char('/') + name + QStringLiteral("/S02/E02.mkv"), QByteArray(768 * 1024, 'B'));
  write(root + QLatin1Char('/') + name + QStringLiteral("/Bonus/Sample.mkv"), QByteArray(32769, 'C'));
  lt::file_storage storage;
  lt::add_files(storage, (root + QLatin1Char('/') + name).toStdString());
  lt::create_torrent create(storage, 64 * 1024, lt::create_torrent::v1_only);
  wp::test::setV1Hashes(create, storage, root);
  std::vector<char> bytes;
  lt::bencode(std::back_inserter(bytes), create.generate());
  const auto path = root + QLatin1Char('/') + name + QStringLiteral(".torrent");
  write(path, QByteArray(bytes.data(), bytes.size()));
  return path;
}
} // namespace
class WaitingSource final : public wp::MediaSource {
public:
  QList<wp::TorrentFile> files() const override { return {{0, QStringLiteral("waiting.mkv"), 1048576, 0}}; }
  bool selected(int i) const override { return i == 0; }
  bool paused() const override { return false; }
  bool hasPiece(int) const override { return false; }
  void requestPiece(int, int) override {}
  void cancelDeadline(int) override {}
  void readPiece(int) override {}
  int pieceLength() const override { return 65536; }
  int pieceSize(int) const override { return 65536; }
  qint64 totalSize() const override { return 1048576; }
};
class LocalServices final : public QObject {
  Q_OBJECT
private slots:
  void torrentFileUploadsRequireOptInWhileDownloadingAndAfterCompletion() {
    try {
      QTemporaryDir tmp;
      const auto seedRoot = tmp.filePath(QStringLiteral("original"));
      const auto metadata = torrent(seedRoot, QStringLiteral("Upload policy"));
      wp::LocalStore store(tmp.filePath(QStringLiteral("profile")));
      wp::TransferEngine engine(store, nullptr, true);
      QCOMPARE(engine.configuration().value(QStringLiteral("seedPolicy")).toString(), QStringLiteral("off"));
      QCOMPARE(engine.configuration().value(QStringLiteral("sharingMode")).toString(), QStringLiteral("p2p-relay"));
      engine.configure({{QStringLiteral("reserveMiB"), 0}, {QStringLiteral("upLimit"), 16 * 1024}});
      const auto id = engine.add(metadata);
      auto *source = engine.source(id);
      QVERIFY(source);
      QHash<int, int> choices;
      wp::TorrentFile available{};
      for (const auto &file : source->files()) {
        choices.insert(file.index, 4);
        if (file.size >= 64 * 1024 && available.size == 0)
          available = file;
      }
      QVERIFY(available.size > 0);
      QFile original(QDir(seedRoot).filePath(available.path));
      QVERIFY(original.open(QIODevice::ReadOnly));
      const auto disk = QDir(engine.view(id).path).filePath(
          engine.intent(id).value(QStringLiteral("diskPaths")).toObject()
              .value(QString::number(available.index)).toString());
      write(disk, original.readAll());
      engine.select(id, choices);
      engine.recheck(id);
      const int piece = int((available.offset + source->pieceLength() - 1) / source->pieceLength());
      QTRY_VERIFY_WITH_TIMEOUT(source->hasPiece(piece), 10000);
      QTRY_VERIFY_WITH_TIMEOUT(engine.view(id).verified > 0 && engine.view(id).verified < engine.view(id).wanted, 10000);
      QVERIFY(!engine.view(id).uploadsEnabled);
      QTRY_VERIFY_WITH_TIMEOUT(engine.port() > 0, 5000);

      lt::settings_pack settings;
      settings.set_str(lt::settings_pack::listen_interfaces, wp::torrentListenInterface(true));
      settings.set_bool(lt::settings_pack::enable_dht, false);
      settings.set_bool(lt::settings_pack::enable_lsd, false);
      settings.set_bool(lt::settings_pack::enable_upnp, false);
      settings.set_bool(lt::settings_pack::enable_natpmp, false);
      lt::session leecher(settings);
      lt::add_torrent_params params;
      params.ti = std::make_shared<lt::torrent_info>(metadata.toStdString());
      params.save_path = tmp.filePath(QStringLiteral("leecher")).toStdString();
      params.flags &= ~(lt::torrent_flags::auto_managed | lt::torrent_flags::paused);
      params.file_priorities.assign(params.ti->num_files(), lt::dont_download);
      params.file_priorities[available.index] = lt::default_priority;
      auto peer = leecher.add_torrent(params);
      peer.connect_peer({lt::make_address("127.0.0.1"), engine.port()});
      QTRY_VERIFY_WITH_TIMEOUT(peer.status().num_peers > 0, 10000);
      QTest::qWait(2500);
      QCOMPARE(peer.status().total_payload_download, qint64(0));
      QCOMPARE(engine.view(id).uploaded, qint64(0));

      auto configuration = engine.configuration();
      configuration.insert(QStringLiteral("seedPolicy"), QStringLiteral("unlimited"));
      engine.configure(configuration);
      QCOMPARE(engine.seedingPolicy(id), QStringLiteral("unlimited"));
      QTest::qWait(300);
      peer.connect_peer({lt::make_address("127.0.0.1"), engine.port()});
      QTRY_VERIFY_WITH_TIMEOUT(peer.status().total_payload_download > 0, 15000);
      QVERIFY(peer.status().total_wanted_done < peer.status().total_wanted);
      engine.setLimits(id, 0, 0, 0, 0, QStringLiteral("off"));
      QVERIFY(!engine.view(id).uploadsEnabled);
      QTest::qWait(1500);
      const auto stopped = peer.status().total_payload_download;
      QTest::qWait(1500);
      QCOMPARE(peer.status().total_payload_download, stopped);
      QCOMPARE(store.get(QStringLiteral("transfer"), id).value(QStringLiteral("seedPolicy")).toString(), QStringLiteral("off"));

      for (const auto &file : source->files()) {
        QFile input(QDir(seedRoot).filePath(file.path));
        QVERIFY(input.open(QIODevice::ReadOnly));
        write(QDir(engine.view(id).path).filePath(engine.intent(id).value(QStringLiteral("diskPaths")).toObject()
                  .value(QString::number(file.index)).toString()), input.readAll());
      }
      engine.recheck(id);
      QTRY_COMPARE_WITH_TIMEOUT(engine.view(id).state, QStringLiteral("Complete"), 10000);
      QVERIFY(!engine.view(id).uploadsEnabled);
      for (const auto &policy : {QStringLiteral("ratio1"), QStringLiteral("ratio2"), QStringLiteral("unlimited")}) {
        engine.setLimits(id, 0, 0, 0, 0, policy);
        QCOMPARE(engine.seedingPolicy(id), policy);
      }
      engine.setLimits(id, 0, 0, 1.5, 20, QStringLiteral("custom"));
      QCOMPARE(engine.intent(id).value(QStringLiteral("seedRatio")).toDouble(), 1.5);
      QCOMPARE(engine.intent(id).value(QStringLiteral("seedMinutes")).toInt(), 20);
      QVERIFY_EXCEPTION_THROWN(engine.setLimits(id, 0, 0, 0, 0, QStringLiteral("invalid")), wp::AppError);
    } catch (const std::exception &error) {
      QFAIL(error.what());
    }
  }
  void populatedPortableTorrentResumesWithoutRenamingExistingFiles_data() {
    QTest::addColumn<bool>("staleMapping");
    QTest::newRow("saved-mapping") << false;
    QTest::newRow("interrupted-checkpoint") << true;
  }
  void populatedPortableTorrentResumesWithoutRenamingExistingFiles() {
    QFETCH(bool, staleMapping);
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const QByteArray payload(65536, 'R');
    lt::file_storage storage;
    storage.add_file(
        (QStringLiteral("Pack/") + QString(200, QLatin1Char('a')) + QStringLiteral(".mkv")).toStdString(),
        payload.size());
    lt::create_torrent create(storage, 65536, lt::create_torrent::v1_only);
    create.set_hash(lt::piece_index_t(0), lt::hasher(payload.constData(), payload.size()).final());
    std::vector<char> encoded;
    lt::bencode(std::back_inserter(encoded), create.generate());
    const auto metadata = tmp.filePath(QStringLiteral("portable-data.torrent"));
    write(metadata, QByteArray(encoded.data(), encoded.size()));
    const auto profile = tmp.filePath(QStringLiteral("profile"));
    QString id, disk;
    {
      wp::LocalStore store(profile);
      wp::TransferEngine engine(store, nullptr, true);
      engine.configure({{QStringLiteral("reserveMiB"), 0}});
      id = engine.add(metadata);
      engine.checkpoint();
      QTRY_COMPARE_WITH_TIMEOUT(engine.pendingCheckpoints(), 0, 10000);
      disk = QDir(engine.view(id).path)
                 .filePath(engine.intent(id)
                               .value(QStringLiteral("diskPaths"))
                               .toObject()
                               .value(QStringLiteral("0"))
                               .toString());
      write(disk, payload);
      engine.select(id, {{0, 4}});
      engine.recheck(id);
      QTRY_VERIFY_WITH_TIMEOUT(engine.source(id)->hasPiece(0), 10000);
      engine.checkpoint();
      QTRY_COMPARE_WITH_TIMEOUT(engine.pendingCheckpoints(), 0, 10000);
    }
    if (staleMapping) {
      // Simulate termination after the portable file was created, before its
      // native rename mapping reached the durable resume checkpoint.
      wp::LocalStore store(profile);
      auto row = store.get(QStringLiteral("transfer"), id);
      const auto bytes = QByteArray::fromBase64(row.value(QStringLiteral("resume")).toString().toLatin1());
      auto params = lt::read_resume_data(lt::span<const char>(bytes.constData(), bytes.size()));
      params.renamed_files.clear();
      params.ti = std::make_shared<lt::torrent_info>(metadata.toStdString());
      const auto encodedResume = lt::write_resume_data_buf(params);
      row.insert(QStringLiteral("resume"),
                 QString::fromLatin1(QByteArray(encodedResume.data(), encodedResume.size()).toBase64()));
      store.put(QStringLiteral("transfer"), id, row);
    }
    for (int restart = 0; restart < 2; ++restart) {
      wp::LocalStore store(profile);
      wp::TransferEngine engine(store, nullptr, true);
      engine.restore();
      QTRY_VERIFY_WITH_TIMEOUT(engine.source(id)->hasPiece(0), 10000);
      engine.checkpoint();
      QTRY_COMPARE_WITH_TIMEOUT(engine.pendingCheckpoints(), 0, 10000);
      QTest::qWait(1500); // Drain asynchronous native rename failures, not just initial state.
      QVERIFY2(engine.view(id).error.isEmpty(), qPrintable(engine.view(id).error));
      QFile file(disk);
      QVERIFY(file.open(QIODevice::ReadOnly));
      QCOMPARE(file.readAll(), payload);
    }
  }
  void portableTorrentNamesKeepOriginalManifestIndexesAcrossRestart() {
    try {
      QTemporaryDir tmp;
      lt::file_storage storage;
      const QStringList paths{
          QStringLiteral("Pack/Season/E01.mkv"), QStringLiteral("Pack/season/e01.mkv"),
          QStringLiteral("Pack/CON.mkv"),
          QStringLiteral("Pack/deep/") + QString(110, QChar(0x65e5)) + QStringLiteral(".mkv"),
          QStringLiteral("Pack/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z/episode.mkv")};
      for (const auto &path : paths)
        storage.add_file(path.toStdString(), 4096);
      lt::create_torrent create(storage, 16384, lt::create_torrent::v1_only);
      for (auto piece : storage.piece_range())
        create.set_hash(piece, lt::hasher("fixture", 7).final());
      std::vector<char> encoded;
      lt::bencode(std::back_inserter(encoded), create.generate());
      const auto metadata = tmp.filePath(QStringLiteral("portable.torrent"));
      write(metadata, QByteArray(encoded.data(), encoded.size()));
      const auto profile = tmp.filePath(QStringLiteral("profile"));
      QString id;
      QJsonObject mapping;
      QList<wp::TorrentFile> original;
      {
        wp::LocalStore store(profile);
        wp::TransferEngine engine(store, nullptr, true);
        id = engine.add(metadata);
        original = engine.source(id)->files();
        mapping = engine.intent(id).value(QStringLiteral("diskPaths")).toObject();
        QCOMPARE(original.size(), paths.size());
        QSet<QString> names;
        for (const auto &file : original) {
          const auto disk = mapping.value(QString::number(file.index)).toString();
          QVERIFY(!names.contains(disk.toCaseFolded()));
          names.insert(disk.toCaseFolded());
          for (const auto &component : disk.split(QLatin1Char('/')))
            QVERIFY(component.toUtf8().size() <= 200);
          QVERIFY(!engine.source(id)->selected(file.index));
        }
        engine.checkpoint();
        QTRY_COMPARE_WITH_TIMEOUT(engine.pendingCheckpoints(), 0, 10000);
      }
      wp::LocalStore store(profile);
      wp::TransferEngine restored(store, nullptr, true);
      restored.restore();
      QCOMPARE(restored.intent(id).value(QStringLiteral("diskPaths")).toObject(), mapping);
      const auto files = restored.source(id)->files();
      QCOMPARE(files.size(), original.size());
      for (int i = 0; i < files.size(); ++i) {
        QCOMPARE(files[i].index, original[i].index);
        QCOMPARE(files[i].path, original[i].path);
      }
    } catch (const std::exception &e) {
      QFAIL(e.what());
    }
  }
  void addingRemovedCopiesReusesOwnedStorageAndPartialDownloadState() {
    try {
      QTemporaryDir tmp;
      wp::LocalStore store(tmp.filePath(QStringLiteral("profile")));
      wp::TransferEngine engine(store, nullptr, true);
      engine.configure({{QStringLiteral("reserveMiB"), 0}});
      const auto metadata = torrent(tmp.filePath(QStringLiteral("seed")), QStringLiteral("Retained pack"));
      const auto id = engine.add(metadata);
      const auto original = engine.view(id).path;
      engine.setPaused(id, true);
      engine.remove(id, false);
      QTRY_VERIFY_WITH_TIMEOUT(!engine.source(id), 5000);
      QCOMPARE(engine.add(metadata), id);
      QCOMPARE(engine.view(id).path, original);
      QVERIFY(engine.source(id)->paused());
      QVERIFY(store.get(QStringLiteral("retained-media"), id).isEmpty());
      wp::LibraryService library(store);
      wp::DirectDownloads direct(store, library, engine);
      const QUrl url(QStringLiteral("https://example.invalid/movie.mp4"));
      const auto directId = direct.add(url, QStringLiteral("Movie"));
      const auto path = direct.download(directId).value(QStringLiteral("path")).toString();
      write(path + QStringLiteral(".part"), "partial verified by ETag on resume");
      direct.remove(directId);
      QCOMPARE(direct.add(url, QStringLiteral("Movie again")), directId);
      QCOMPARE(direct.download(directId).value(QStringLiteral("path")).toString(), path);
      QCOMPARE(QFileInfo(path + QStringLiteral(".part")).size(), 34);
      QVERIFY(store.get(QStringLiteral("retained-media"), directId).isEmpty());
    } catch (const std::exception &e) {
      QFAIL(e.what());
    }
  }
  void singleInstanceUsesPrivateAuthenticatedInviteHandoff() {
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const auto profile = tmp.filePath(QStringLiteral("profile"));
    wp::SingleInstance first(profile);
    QVERIFY(first.acquireOrForward({}));
    QSignalSpy activated(&first, &wp::SingleInstance::activate);
    const QString link = QStringLiteral(
        "watchpair://"
        "room?server=https%3A%2F%2Fexample.org&room=00000000-0000-4000-8000-000000000000#invite=private");
    auto forwarding = QtConcurrent::run([profile, link] {
      wp::SingleInstance second(profile);
      return second.acquireOrForward(link);
    });
    QTRY_VERIFY_WITH_TIMEOUT(forwarding.isFinished(), 6000);
    QVERIFY(!forwarding.result());
    QCOMPARE(activated.size(), 1);
    QCOMPARE(activated.first().first().toString(), link);
    const auto entry = wp::desktop::desktopEntry(QStringLiteral("/path with spaces/$cash%20/WatchPair"));
    QVERIFY(entry.contains(QStringLiteral("\\$cash%%20")));
    QVERIFY(entry.contains(QStringLiteral("%u")));
  }
  void databaseTransactionsAndVersion() {
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const auto profile = tmp.path() + QStringLiteral("/profile");
    {
      wp::LocalStore store(profile);
      store.put(QStringLiteral("test"), QStringLiteral("one"), {{QStringLiteral("value"), 12}});
      QVERIFY_EXCEPTION_THROWN(store.transaction([&] {
        store.put(QStringLiteral("test"), QStringLiteral("two"), {{QStringLiteral("value"), 13}});
        throw std::runtime_error("rollback");
      }),
                               std::runtime_error);
      QVERIFY(store.get(QStringLiteral("test"), QStringLiteral("two")).isEmpty());
      QCOMPARE(
          store.get(QStringLiteral("test"), QStringLiteral("one")).value(QStringLiteral("value")).toInt(),
          12);
    }
    {
      auto db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), QStringLiteral("future"));
      db.setDatabaseName(profile + QStringLiteral("/watchpair-v2.sqlite"));
      QVERIFY(db.open());
      {
        QSqlQuery q(db);
        QVERIFY(q.exec(QStringLiteral("PRAGMA user_version=99")));
      }
      db.close();
    }
    QSqlDatabase::removeDatabase(QStringLiteral("future"));
    QVERIFY_EXCEPTION_THROWN(wp::LocalStore newer(profile), wp::AppError);
    QVERIFY_EXCEPTION_THROWN(wp::LocalStore again(profile), wp::AppError);
  }
  void multiTransferSelectionPauseAndRecovery() {
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const auto root = tmp.path();
    const auto seedRoot = root + QStringLiteral("/seed");
    const auto first = torrent(seedRoot, QStringLiteral("Show one")),
               second = torrent(seedRoot, QStringLiteral("Show two"));
    const auto profile = root + QStringLiteral("/profile");
    QString id, other;
    int a = -1, b = -1;
    {
      wp::LocalStore store(profile);
      wp::TransferEngine engine(store, nullptr, true);
      engine.configure({{QStringLiteral("reserveMiB"), 0}, {QStringLiteral("concurrency"), 1}});
      write(root + QStringLiteral("/downloads/Show one/unrelated.txt"), QByteArray("keep me"));
      id = engine.add(first, root + QStringLiteral("/downloads"));
      other = engine.add(second, root + QStringLiteral("/downloads"));
      QCOMPARE(engine.add(first), id);
      QCOMPARE(engine.transfers().size(), 2);
      auto *source = engine.source(id);
      QVERIFY(source);
      QCOMPARE(source->files().size(), 3);
      for (const auto &f : source->files()) {
        QVERIFY(!source->selected(f.index));
        if (f.path.contains(QStringLiteral("S01")))
          a = f.index;
        if (f.path.contains(QStringLiteral("S02")))
          b = f.index;
      }
      QVERIFY(a >= 0 && b >= 0);
      QVERIFY(QFileInfo::exists(root + QStringLiteral("/downloads/Show one/unrelated.txt")));
      engine.setDemand(QStringLiteral("room1"), id, {a}, QStringLiteral("Ask"), false);
      QVERIFY(!source->selected(a));
      engine.setDemand(QStringLiteral("room1"), id, {a}, QStringLiteral("Ask"), true);
      QVERIFY(source->selected(a));
      qint64 expectedBytes = 0;
      for (const auto &file : source->files())
        if (file.index == a)
          expectedBytes = file.size;
      QCOMPARE(engine.view(id).wanted, expectedBytes);
      QVERIFY(engine.view(id).state != QStringLiteral("Seeding"));
      engine.setDemand(QStringLiteral("room2"), id, {b}, QStringLiteral("Auto"), false);
      QVERIFY(source->selected(b));
      engine.select(id, {{a, 4}});
      QVERIFY(source->selected(a));
      QVERIFY(!source->selected(b));
      engine.setDemand(QStringLiteral("room2"), id, {a, b}, QStringLiteral("Auto"), true);
      QVERIFY(!source->selected(b));
      engine.followRoomSelection(id);
      QVERIFY(source->selected(b));
      engine.removeDemand(QStringLiteral("room1"));
      QVERIFY(source->selected(a));
      engine.setPaused(id, true);
      engine.setPlayback(id, a);
      QVERIFY(source->paused());
      engine.setPlayback({}, -1);
      engine.setOrder({other, id});
      QCOMPARE(engine.transfers().first().id, other);
      engine.setLimits(id, 50000, 12000, 1.5, 20);
      engine.setPinned(id, true);
      QVERIFY_EXCEPTION_THROWN(engine.remove(id), wp::AppError);
      engine.setPinned(id, false);
      engine.setTrackers(id, {QStringLiteral("https://example.invalid/announce")});
      engine.checkpoint();
      QTRY_COMPARE_WITH_TIMEOUT(engine.pendingCheckpoints(), 0, 10000);
    }
    {
      wp::LocalStore store(profile);
      wp::TransferEngine restored(store, nullptr, true);
      restored.restore();
      QCOMPARE(restored.transfers().size(), 2);
      QVERIFY(restored.source(id)->paused());
      QVERIFY(restored.source(id)->selected(a));
      QVERIFY(restored.source(id)->selected(b));
      QCOMPARE(restored.intent(id).value(QStringLiteral("downLimit")).toInt(), 50000);
      QCOMPARE(restored.trackers(id).size(), 1);
      const auto old = restored.view(id).path;
      restored.move(id, root + QStringLiteral("/moved"));
      QTRY_VERIFY_WITH_TIMEOUT(restored.view(id).path != old, 15000);
      QVERIFY(store.get(QStringLiteral("storage-job"), id).isEmpty());
      const auto newRoot = restored.view(id).path;
      write(newRoot + QStringLiteral("/unrelated.txt"), QByteArray("keep this too"));
      restored.remove(id, true);
      QTRY_COMPARE_WITH_TIMEOUT(restored.transfers().size(), 1, 5000);
      QVERIFY(QFileInfo::exists(newRoot + QStringLiteral("/unrelated.txt")));
    }
  }
  void verifiedProductionTorrentReader() {
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const auto root = tmp.path(), seedPath = root + QStringLiteral("/seed");
    const auto path = torrent(seedPath, QStringLiteral("Reader pack"));
    lt::settings_pack config;
    config.set_str(lt::settings_pack::listen_interfaces, wp::torrentListenInterface(true));
    config.set_bool(lt::settings_pack::enable_dht, false);
    config.set_bool(lt::settings_pack::enable_lsd, false);
    config.set_bool(lt::settings_pack::enable_upnp, false);
    config.set_bool(lt::settings_pack::enable_natpmp, false);
    config.set_bool(lt::settings_pack::close_redundant_connections, false);
    lt::session seed(config);
    lt::add_torrent_params p;
    p.ti = std::make_shared<lt::torrent_info>(path.toStdString());
    p.save_path = seedPath.toStdString();
    p.flags &= ~lt::torrent_flags::auto_managed;
    p.flags &= ~lt::torrent_flags::paused;
    p.flags |= lt::torrent_flags::seed_mode;
    auto handle = seed.add_torrent(p);
    QTRY_VERIFY_WITH_TIMEOUT(seed.listen_port() > 0 && handle.status().is_seeding, 10000);
    wp::LocalStore store(root + QStringLiteral("/profile"));
    wp::TransferEngine engine(store, nullptr, true);
    engine.configure({{QStringLiteral("reserveMiB"), 0}});
    const auto id = engine.add(path);
    auto *source = engine.source(id);
    int index = -1;
    for (const auto &f : source->files())
      if (f.path.contains(QStringLiteral("S02")))
        index = f.index;
    QVERIFY(index >= 0);
    engine.select(id, {{index, 4}});
    engine.setPlayback(id, index);
    QTimer peer;
    connect(&peer, &QTimer::timeout, this,
            [&] { engine.connectPeer(id, QStringLiteral("127.0.0.1"), seed.listen_port()); });
    peer.start(250);
    wp::VerifiedStream stream(*source);
    QNetworkAccessManager net;
    QNetworkRequest request(stream.url(index));
    request.setRawHeader("Range", "bytes=17-99001");
    auto *reply = net.get(request);
    QSignalSpy done(reply, &QNetworkReply::finished);
    QVERIFY(done.wait(25000));
    QCOMPARE(reply->error(), QNetworkReply::NoError);
    QCOMPARE(reply->readAll(), QByteArray(99001 - 17 + 1, 'B'));
    reply->deleteLater();
  }
  void unavailableStorageRemainsVisibleAndCanBeRepaired() {
    try {
      QTemporaryDir tmp;
      QVERIFY(tmp.isValid());
      const auto path = torrent(tmp.path() + QStringLiteral("/seed"), QStringLiteral("Repair pack"));
      const auto profile = tmp.path() + QStringLiteral("/profile");
      QString id, directory;
      {
        wp::LocalStore store(profile);
        wp::TransferEngine engine(store, nullptr, true);
        id = engine.add(path);
        directory = engine.view(id).path;
        engine.checkpoint();
        QTRY_COMPARE_WITH_TIMEOUT(engine.pendingCheckpoints(), 0, 10000);
      }
      QVERIFY(QFile::remove(directory + QStringLiteral("/.watchpair-owner")));
      write(directory + QStringLiteral("/unrelated.txt"), QByteArray("untouched"));
      {
        wp::LocalStore store(profile);
        wp::TransferEngine engine(store, nullptr, true);
        engine.restore();
        QCOMPARE(engine.transfers().size(), 1);
        QCOMPARE(engine.view(id).state, QStringLiteral("Error"));
        QVERIFY_EXCEPTION_THROWN(engine.remove(id, true), wp::AppError);
        engine.relocateMissing(id, tmp.path() + QStringLiteral("/repair"));
        QVERIFY(engine.view(id).path != directory);
        QVERIFY(engine.source(id)->files().size() == 3);
        QVERIFY(QFileInfo::exists(directory + QStringLiteral("/unrelated.txt")));
        engine.configure({{QStringLiteral("offline"), true}});
        QTRY_COMPARE_WITH_TIMEOUT(engine.port(), 0, 3000);
        QVERIFY(engine.source(id)->paused());
        engine.configure({});
        QTRY_VERIFY_WITH_TIMEOUT(engine.port() > 0, 3000);
      }
    } catch (const std::exception &e) {
      QFAIL(e.what());
    }
  }
  void libraryUsesIdentityAndDetectsChanges() {
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const auto root = tmp.path();
    write(root + QStringLiteral("/library/S01/E01.mkv"), QByteArray(8192, 'v'));
    write(root + QStringLiteral("/library/S02/E01.mkv"), QByteArray(8192, 'x'));
    wp::LocalStore store(root + QStringLiteral("/profile"));
    wp::LibraryService library(store);
    const auto id = library.addRoot(root + QStringLiteral("/library"));
    library.scan(id);
    QTRY_VERIFY_WITH_TIMEOUT(!library.scanning(), 10000);
    QCOMPARE(library.files().size(), 2);
    const auto sha = QString::fromLatin1(
        QCryptographicHash::hash(QByteArray(8192, 'v'), QCryptographicHash::Sha256).toHex());
    const auto found = library.match(sha);
    QVERIFY(!found.isEmpty());
    QVERIFY(found.value(QStringLiteral("path")).toString().contains(QStringLiteral("S01")));
    wp::LocalFileSource source(found);
    QSignalSpy read(&source, &wp::MediaSource::pieceRead);
    source.readPiece(0);
    QVERIFY(read.wait(10000));
    QCOMPARE(read.first().at(1).toByteArray(), QByteArray(8192, 'v'));
    write(found.value(QStringLiteral("path")).toString(), QByteArray(4000, 'a'));
    QVERIFY(!source.hasPiece(0));
    QVERIFY(library.match(sha).isEmpty());
    QFile::remove(root + QStringLiteral("/library/S02/E01.mkv"));
    library.scan(id);
    QTRY_VERIFY_WITH_TIMEOUT(!library.scanning(), 10000);
    int missing = 0;
    for (auto item : library.files())
      if (item.toObject().value(QStringLiteral("missing")).toBool())
        ++missing;
    QCOMPARE(missing, 1);
  }
  void removedMediaSourceClosesReaderAndBindDoesNotFallBack() {
    auto source = std::make_unique<WaitingSource>();
    wp::VerifiedStream stream(*source);
    QNetworkAccessManager net;
    QSignalSpy waiting(&stream, &wp::VerifiedStream::waiting);
    auto *reply = net.get(QNetworkRequest(stream.url(0)));
    QSignalSpy done(reply, &QNetworkReply::finished);
    QTRY_VERIFY_WITH_TIMEOUT(!waiting.isEmpty(), 3000);
    source.reset();
    QTRY_VERIFY_WITH_TIMEOUT(!done.isEmpty(), 3000);
    QVERIFY(reply->error() != QNetworkReply::NoError);
    reply->deleteLater();
    QVERIFY(stream.diagnostics().contains(QStringLiteral("removed")));
    QTcpServer server;
    QVERIFY(server.listen(QHostAddress::LocalHost, 0));
    QSignalSpy incoming(&server, &QTcpServer::newConnection);
    wp::HttpOptions options;
    options.url = QUrl(QStringLiteral("http://127.0.0.1:%1/private.mp4").arg(server.serverPort()));
    options.bindAddress = QStringLiteral("192.0.2.123");
    options.control = std::make_shared<wp::HttpControl>();
    QFutureWatcher<wp::HttpResult> watcher;
    QSignalSpy finished(&watcher, &QFutureWatcher<wp::HttpResult>::finished);
    watcher.setFuture(QtConcurrent::run([options] { return wp::fetchHttp(options); }));
    QVERIFY(finished.wait(5000));
    QVERIFY(!watcher.result().error.isEmpty());
    QVERIFY(incoming.isEmpty());
  }
  void oneDeviceQueueArbitratesTorrentHttpAndSharedPlaybackWithoutOverridingPauses() {
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    wp::LocalStore store(tmp.filePath(QStringLiteral("profile")));
    wp::TransferEngine engine(store, nullptr, true);
    engine.configure({{QStringLiteral("concurrency"), 1}, {QStringLiteral("reserveMiB"), 0}});
    const auto native =
        engine.add(torrent(tmp.filePath(QStringLiteral("seed")), QStringLiteral("Queue fixture")));
    engine.select(native, {{0, 4}});
    wp::LibraryService library(store);
    wp::DirectDownloads direct(store, library, engine);
    const QByteArray bytes(65536, 'q');
    QTcpServer origin;
    QVERIFY(origin.listen(QHostAddress::LocalHost, 0));
    QSignalSpy incoming(&origin, &QTcpServer::newConnection);
    connect(&origin, &QTcpServer::newConnection, this, [&] {
      while (origin.hasPendingConnections()) {
        auto *socket = origin.nextPendingConnection();
        connect(socket, &QTcpSocket::readyRead, socket, [socket, bytes] {
          if (!socket->readAll().contains("\r\n\r\n"))
            return;
          socket->write("HTTP/1.1 200 OK\r\nContent-Length: " + QByteArray::number(bytes.size()) +
                        "\r\nConnection: close\r\n\r\n" + bytes);
          socket->disconnectFromHost();
        });
        connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
      }
    });
    const auto http =
        direct.add(QUrl(QStringLiteral("http://127.0.0.1:%1/queue.mp4").arg(origin.serverPort())),
                   QStringLiteral("Queued HTTP"));
    direct.resume(http);
    QCOMPARE(direct.download(http).value(QStringLiteral("state")).toString(), QStringLiteral("Queued"));
    QTest::qWait(300);
    QVERIFY(incoming.isEmpty());
    QVERIFY(engine.hasDownloadSlot(QStringLiteral("torrent:") + native));
    engine.moveQueue(QStringLiteral("direct:") + http, -1);
    QTRY_COMPARE_WITH_TIMEOUT(direct.download(http).value(QStringLiteral("state")).toString(),
                              QStringLiteral("Ready"), 6000);
    QCOMPARE(incoming.size(), 1);
    engine.setExternalWork(QStringLiteral("share:fixture"), true, true);
    QVERIFY(engine.hasDownloadSlot(QStringLiteral("share:fixture")));
    QVERIFY(!engine.hasDownloadSlot(QStringLiteral("torrent:") + native));
    engine.setPlayback(native, 0);
    QVERIFY(engine.hasDownloadSlot(QStringLiteral("torrent:") + native));
    engine.setPaused(native, true);
    QVERIFY(engine.hasDownloadSlot(QStringLiteral("share:fixture")));
    QVERIFY(engine.intent(native).value(QStringLiteral("manualPaused")).toBool());
    engine.forgetExternalWork(QStringLiteral("share:fixture"));
  }
  void rangeResumeValidatesTheOriginAndNeverAppendsAReplacement() {
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const auto path = tmp.filePath(QStringLiteral("media.part"));
    const QByteArray original(65536, 'a'), replacement(8192, 'b');
    int mode = 0;
    QByteArray lastRequest;
    QTcpServer server;
    QVERIFY(server.listen(QHostAddress::LocalHost, 0));
    connect(&server, &QTcpServer::newConnection, this, [&] {
      while (server.hasPendingConnections()) {
        auto *socket = server.nextPendingConnection();
        auto request = std::make_shared<QByteArray>();
        connect(socket, &QTcpSocket::readyRead, socket, [&, socket, request] {
          request->append(socket->readAll());
          if (!request->contains("\r\n\r\n"))
            return;
          lastRequest = *request;
          const auto body = mode == 1 ? replacement : original.mid(32768);
          socket->write(mode == 1 ? "HTTP/1.1 200 OK\r\nETag: \"new\"\r\n"
                                  : "HTTP/1.1 206 Partial Content\r\nETag: \"one\"\r\n");
          if (mode != 1)
            socket->write(mode == 2 ? "Content-Range: bytes 0-32767/65536\r\n"
                                    : "Content-Range: bytes 32768-65535/65536\r\n");
          socket->write("Content-Length: " + QByteArray::number(body.size()) +
                        "\r\nConnection: close\r\n\r\n" + body);
          socket->disconnectFromHost();
        });
        connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
      }
    });
    auto fetch = [&](bool automatic = false) {
      wp::HttpOptions options;
      options.url = QUrl(QStringLiteral("http://127.0.0.1:%1/video.mkv").arg(server.serverPort()));
      options.destination = path;
      options.resumeOffset = 32768;
      options.resumeEtag = "\"one\"";
      options.reserveMiB = 0;
      options.control = std::make_shared<wp::HttpControl>();
      options.allowPrivate = !automatic;
      QFutureWatcher<wp::HttpResult> watcher;
      watcher.setFuture(QtConcurrent::run([options] { return wp::fetchHttp(options); }));
      QElapsedTimer timer;
      timer.start();
      while (!watcher.isFinished() && timer.elapsed() < 5000)
        QTest::qWait(10);
      return watcher.result();
    };
    write(path, original.left(32768));
    auto result = fetch();
    QVERIFY2(result.error.isEmpty(), qPrintable(result.error));
    QCOMPARE(result.acceptedOffset, 32768);
    QVERIFY(lastRequest.contains("Range: bytes=32768-"));
    QVERIFY(lastRequest.contains("If-Range: \"one\""));
    QFile file(path);
    QVERIFY(file.open(QIODevice::ReadOnly));
    QCOMPARE(file.readAll(), original);
    file.close();
    mode = 1;
    write(path, original.left(32768));
    result = fetch();
    QVERIFY(result.error.isEmpty());
    QCOMPARE(result.acceptedOffset, 0);
    QVERIFY(file.open(QIODevice::ReadOnly));
    QCOMPARE(file.readAll(), replacement);
    file.close();
    mode = 2;
    write(path, original.left(32768));
    result = fetch();
    QVERIFY(!result.error.isEmpty());
    QCOMPARE(QFileInfo(path).size(), 32768);
    result = fetch(true);
    QVERIFY(!result.error.isEmpty());
  }
  void ownedStorageMovesPinsPreviewAndExternalFilesAreSafe() {
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    wp::AppServices app(tmp.filePath(QStringLiteral("profile")), nullptr, true, true);
    app.transfers.configure({{QStringLiteral("reserveMiB"), 0}});
    const auto root = wp::owned::allocate(tmp.filePath(QStringLiteral("copies")), QStringLiteral("copy"),
                                          QStringLiteral("nonce"));
    const auto path = root + QStringLiteral("/media.mkv");
    write(path, QByteArray(3 * 1024 * 1024, 'v'));
    write(root + QStringLiteral("/unrelated.txt"), "keep");
    QSignalSpy identified(&app.library, &wp::LibraryService::identified);
    app.library.identify(path);
    QTRY_COMPARE_WITH_TIMEOUT(identified.size(), 1, 10000);
    const auto file = identified.first().at(1).toJsonObject();
    app.store.put(QStringLiteral("direct"), QStringLiteral("copy"),
                  {{QStringLiteral("id"), QStringLiteral("copy")},
                   {QStringLiteral("root"), root},
                   {QStringLiteral("nonce"), QStringLiteral("nonce")},
                   {QStringLiteral("path"), path},
                   {QStringLiteral("file"), file},
                   {QStringLiteral("state"), QStringLiteral("Ready")},
                   {QStringLiteral("label"), QStringLiteral("Owned copy")}});
    app.direct.restore();
    app.storage.setPinned(QStringLiteral("direct:copy"), true);
    QVERIFY_EXCEPTION_THROWN(app.storage.remove(QStringLiteral("direct:copy"), true), wp::AppError);
    app.storage.setPinned(QStringLiteral("direct:copy"), false);
    app.playback.playLocal(file);
    QVERIFY_EXCEPTION_THROWN(app.storage.remove(QStringLiteral("direct:copy"), true), wp::AppError);
    app.playback.stop();
    app.storage.move(QStringLiteral("direct"), QStringLiteral("copy"), tmp.filePath(QStringLiteral("moved")));
    QTRY_VERIFY_WITH_TIMEOUT(app.store.all(QStringLiteral("file-move")).isEmpty(), 20000);
    const auto moved = app.direct.download(QStringLiteral("copy")).value(QStringLiteral("path")).toString();
    QVERIFY(moved != path);
    QVERIFY(QFileInfo::exists(moved));
    QVERIFY(!QFileInfo::exists(path));
    QVERIFY(QFileInfo::exists(root + QStringLiteral("/unrelated.txt")));
    app.storage.remove(QStringLiteral("direct:copy"), false);
    QVERIFY(app.direct.download(QStringLiteral("copy")).isEmpty());
    QVERIFY(QFileInfo::exists(moved));
    app.storage.configure({{QStringLiteral("enabled"), false},
                           {QStringLiteral("days"), 0},
                           {QStringLiteral("capacityMiB"), 1}});
    QSignalSpy preview(&app.storage, &wp::StorageManager::previewReady);
    app.storage.refresh();
    QTRY_VERIFY_WITH_TIMEOUT(!preview.isEmpty(), 5000);
    const auto candidates = app.storage.candidates(preview.last().first().toJsonArray());
    QCOMPARE(candidates.size(), 1);
    app.storage.setPinned(QStringLiteral("retained:copy"), true);
    QVERIFY_EXCEPTION_THROWN(app.storage.remove(QStringLiteral("retained:copy"), true), wp::AppError);
    app.storage.setPinned(QStringLiteral("retained:copy"), false);
    app.storage.remove(QStringLiteral("retained:copy"), true);
    QVERIFY(!QFileInfo::exists(moved));
    QVERIFY(QFileInfo::exists(root + QStringLiteral("/unrelated.txt")));
    QCOMPARE(app.store.all(QStringLiteral("retained-media")).size(), 0);
  }
  void sourceResolutionAndDirectIntegrityWithHardLimit() {
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const auto root = tmp.path();
    const auto path = torrent(root + QStringLiteral("/seed"), QStringLiteral("Resolver pack"));
    wp::LocalStore store(root + QStringLiteral("/profile"));
    wp::SourceResolver resolver(store);
    qRegisterMetaType<wp::ResolvedSource>();
    QSignalSpy resolved(&resolver, &wp::SourceResolver::resolved),
        failures(&resolver, &wp::SourceResolver::failed);
    resolver.resolve(path);
    QTRY_COMPARE_WITH_TIMEOUT(resolved.size(), 1, 5000);
    auto result = qvariant_cast<wp::ResolvedSource>(resolved.takeFirst().first());
    QCOMPARE(result.kind, QStringLiteral("torrent"));
    QVERIFY(result.localPath.startsWith(store.profile()));
    resolver.resolve(QStringLiteral("https://example.invalid/some-page"));
    QTRY_COMPARE_WITH_TIMEOUT(failures.size(), 1, 5000);
    resolver.resolve(path, true);
    QTRY_COMPARE_WITH_TIMEOUT(failures.size(), 2, 5000);
    const auto cancelled = resolver.resolve(path);
    resolver.cancel(cancelled);
    QTest::qWait(25);
    QVERIFY(resolved.isEmpty());
    const QByteArray bytes(32768, 'd');
    QTcpServer server;
    QVERIFY(server.listen(QHostAddress::LocalHost, 0));
    connect(&server, &QTcpServer::newConnection, this, [&] {
      while (server.hasPendingConnections()) {
        auto *socket = server.nextPendingConnection();
        connect(socket, &QTcpSocket::readyRead, socket, [socket, bytes] {
          auto request = socket->readAll();
          if (!request.contains("\r\n\r\n"))
            return;
          socket->write("HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: " +
                        QByteArray::number(bytes.size()) + "\r\nConnection: close\r\n\r\n" + bytes);
          socket->disconnectFromHost();
        });
        connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
      }
    });
    wp::TransferEngine engine(store, nullptr, true);
    engine.configure({{QStringLiteral("downLimit"), 8192}, {QStringLiteral("reserveMiB"), 0}});
    wp::LibraryService library(store);
    wp::DirectDownloads direct(store, library, engine);
    const QUrl url(QStringLiteral("http://127.0.0.1:%1/movie.mp4").arg(server.serverPort()));
    const auto sha = QString::fromLatin1(QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex());
    const auto id = direct.add(url, QStringLiteral("movie"), sha, bytes.size());
    QUrl otherUrl(url);
    otherUrl.setQuery(QStringLiteral("copy=2"));
    const auto other = direct.add(otherUrl, QStringLiteral("second transfer"), sha, bytes.size());
    QCOMPARE(direct.download(id).value(QStringLiteral("state")).toString(), QStringLiteral("Paused"));
    QElapsedTimer elapsed;
    elapsed.start();
    direct.resume(id);
    direct.resume(other);
    QTRY_VERIFY_WITH_TIMEOUT(direct.download(id).value(QStringLiteral("received")).toInteger() > 0, 5000);
    direct.pause(id);
    direct.resume(id);
    QTRY_VERIFY_WITH_TIMEOUT(
        direct.download(id).value(QStringLiteral("state")).toString() == QStringLiteral("Ready") &&
            direct.download(other).value(QStringLiteral("state")).toString() == QStringLiteral("Ready"),
        26000);
    QVERIFY2(elapsed.elapsed() >= 7500, "Concurrent HTTP downloads must share one 8 KiB/s device cap; idle "
                                        "torrent capacity is lent to active transports");
    QCOMPARE(direct.download(id)
                 .value(QStringLiteral("file"))
                 .toObject()
                 .value(QStringLiteral("sha256"))
                 .toString(),
             sha);
    engine.configure({{QStringLiteral("reserveMiB"), 0}});
    const auto bad =
        direct.add(url, QStringLiteral("wrong content"), QString(64, QLatin1Char('0')), bytes.size());
    direct.resume(bad);
    QTRY_COMPARE_WITH_TIMEOUT(direct.download(bad).value(QStringLiteral("state")).toString(),
                              QStringLiteral("Error"), 5000);
  }
};
int main(int argc, char **argv) {
  QCoreApplication app(argc, argv);
  wp::configureNativeRuntime();
  LocalServices tests;
  return QTest::qExec(&tests, argc, argv);
}
#include "local_services.moc"
