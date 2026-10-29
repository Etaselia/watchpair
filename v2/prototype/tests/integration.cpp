#include "../../testing/torrent_fixture.h"
#include "native_runtime.h"
#include "player.h"
#include "torrent_service.h"
#include "verified_stream.h"
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QProcess>
#include <QTemporaryDir>
#include <QtTest>
#include <algorithm>
#include <libtorrent/bencode.hpp>
#include <libtorrent/create_torrent.hpp>
#include <libtorrent/ip_filter.hpp>
#include <libtorrent/torrent_flags.hpp>

namespace lt = libtorrent;
class Integration final : public QObject {
  Q_OBJECT
private slots:
  void ranges() {
    auto full = wp::parseRange({}, 100);
    QVERIFY(full.valid);
    QCOMPARE(full.first, 0);
    QCOMPARE(full.last, 99);
    QVERIFY(!full.partial);
    auto tail = wp::parseRange("bytes=-7", 100);
    QVERIFY(tail.valid);
    QCOMPARE(tail.first, 93);
    QCOMPARE(tail.last, 99);
    auto clamp = wp::parseRange("bytes=91-999", 100);
    QVERIFY(clamp.valid);
    QCOMPARE(clamp.last, 99);
    for (const auto &value : {"bytes=100-", "bytes=8-2", "bytes=0-1,4-5", "bytes=+1-9", "bytes=-0",
                              "items=1-4", "bytes=999999999999999999999999-"})
      QVERIFY2(!wp::parseRange(value, 100).valid, value);
    QVERIFY(!wp::parseRange({}, 0).valid);
  }
  void progressivePlaybackAndRecovery_data() {
    QTest::addColumn<QString>("container");
    QTest::newRow("mp4") << QStringLiteral("mp4");
    QTest::newRow("mkv") << QStringLiteral("mkv");
  }
  void progressivePlaybackAndRecovery() {
    QFETCH(QString, container);
    QTemporaryDir temporary;
    QVERIFY(temporary.isValid());
    const auto exported = qEnvironmentVariable("WATCHPAIR_FIXTURE_DIR");
    const QString root = QDir::fromNativeSeparators(exported.isEmpty() ? temporary.path() : exported) +
                         QLatin1Char('/') + container;
    QVERIFY(QDir().mkpath(root + QStringLiteral("/seed/Season pack/S01")));
    QVERIFY(QDir().mkpath(root + QStringLiteral("/seed/Season pack/S02")));
    const auto seedRoot = root + QStringLiteral("/seed");
    const auto mediaPath = seedRoot + QStringLiteral("/Season pack/S01/E01.") + container;
    qInfo("Generating deterministic local media fixture");
    QProcess ffmpeg;
    ffmpeg.start(qEnvironmentVariable("WATCHPAIR_FFMPEG", QStringLiteral("ffmpeg")),
                 {QStringLiteral("-hide_banner"),
                  QStringLiteral("-loglevel"),
                  QStringLiteral("error"),
                  QStringLiteral("-y"),
                  QStringLiteral("-f"),
                  QStringLiteral("lavfi"),
                  QStringLiteral("-i"),
                  QStringLiteral("testsrc2=size=320x180:rate=20"),
                  QStringLiteral("-f"),
                  QStringLiteral("lavfi"),
                  QStringLiteral("-i"),
                  QStringLiteral("sine=frequency=500:sample_rate=48000"),
                  QStringLiteral("-t"),
                  QStringLiteral("180"),
                  QStringLiteral("-c:v"),
                  QStringLiteral("libx264"),
                  QStringLiteral("-preset"),
                  QStringLiteral("ultrafast"),
                  QStringLiteral("-b:v"),
                  QStringLiteral("800k"),
                  QStringLiteral("-c:a"),
                  QStringLiteral("aac"),
                  QStringLiteral("-b:a"),
                  QStringLiteral("96k"),
                  mediaPath});
    QVERIFY2(ffmpeg.waitForFinished(45000), "FFmpeg fixture generation timed out");
    QVERIFY2(ffmpeg.exitCode() == 0, ffmpeg.readAllStandardError().constData());
    qInfo("Fixture video generated");
    const auto second = seedRoot + QStringLiteral("/Season pack/S02/E02.") + container;
    if (!QFile::exists(second))
      QVERIFY(QFile::copy(mediaPath, second));
    QFile bonus(seedRoot + QStringLiteral("/Season pack/00-extras.txt"));
    QVERIFY(bonus.open(QIODevice::WriteOnly));
    bonus.write(QByteArray(65573, 'x'));
    bonus.close();
    lt::file_storage storage;
    lt::add_files(storage, (seedRoot + QStringLiteral("/Season pack")).toStdString());
    lt::create_torrent create(storage, 64 * 1024, lt::create_torrent::v1_only);
    wp::test::setV1Hashes(create, storage, seedRoot);
    qInfo("Fixture piece hashes generated");
    std::vector<char> encoded;
    lt::bencode(std::back_inserter(encoded), create.generate());
    const auto torrentPath = root + QStringLiteral("/fixture.torrent");
    QFile torrentFile(torrentPath);
    QVERIFY(torrentFile.open(QIODevice::WriteOnly));
    torrentFile.write(encoded.data(), encoded.size());
    torrentFile.close();

    lt::settings_pack config;
    config.set_str(lt::settings_pack::listen_interfaces, wp::torrentListenInterface(true));
    config.set_bool(lt::settings_pack::enable_dht, false);
    config.set_bool(lt::settings_pack::enable_lsd, false);
    config.set_bool(lt::settings_pack::enable_upnp, false);
    config.set_bool(lt::settings_pack::enable_natpmp, false);
    config.set_int(lt::settings_pack::upload_rate_limit, 256 * 1024);
    config.set_bool(lt::settings_pack::allow_multiple_connections_per_ip, true);
    config.set_bool(lt::settings_pack::close_redundant_connections, false);
    lt::session seeder(config);
    lt::ip_filter limits;
    limits.add_rule(lt::make_address("0.0.0.0"), lt::make_address("255.255.255.255"), 1);
    seeder.set_peer_class_filter(limits);
    lt::add_torrent_params p;
    p.ti = std::make_shared<lt::torrent_info>(torrentPath.toStdString());
    p.save_path = seedRoot.toStdString();
    p.flags &= ~lt::torrent_flags::auto_managed;
    p.flags &= ~lt::torrent_flags::paused;
    // The fixture was just hashed from these exact files. Seed mode verifies
    // each source piece on first read; recipients always use normal verification.
    p.flags |= lt::torrent_flags::seed_mode;
    auto seed = seeder.add_torrent(p);
    auto listening = [&] {
      std::vector<lt::alert *> alerts;
      seeder.pop_alerts(&alerts);
      for (auto *alert : alerts)
        qInfo().noquote() << "Seed startup:" << QString::fromStdString(alert->message());
      return seeder.listen_port() > 0;
    };
    QTRY_VERIFY_WITH_TIMEOUT(listening(), 5000);
    qInfo("Waiting for the local seeder to verify source files");
    QElapsedTimer verification;
    verification.start();
    int checks = 0;
    auto verified = [&] {
      const auto state = seed.status();
      if (++checks % 20 == 1)
        qInfo() << "Seed state" << state.state << "progress" << state.progress << "error"
                << QString::fromStdString(state.errc.message());
      return state.is_seeding;
    };
    QTRY_VERIFY_WITH_TIMEOUT(verified(), 90000);
    qInfo() << "Seeder verification milliseconds:" << verification.elapsed();
    const auto profile = root + QStringLiteral("/leecher-profile");
    int videoIndex = -1;
    double playbackProgress = 1, selectedFileProgress = 1;
    {
      wp::TorrentService leecher(profile, nullptr, true);
      connect(&leecher, &wp::TorrentService::activity, this,
              [](const QString &m) { qInfo().noquote() << m; });
      leecher.add(torrentPath, root + QStringLiteral("/leecher-data"));
      QTRY_VERIFY_WITH_TIMEOUT(!leecher.files().isEmpty(), 5000);
      QCOMPARE(leecher.files().size(), 3);
      for (const auto &f : leecher.files())
        if (f.path.endsWith(QStringLiteral("S01/E01.") + container))
          videoIndex = f.index;
      QVERIFY(videoIndex >= 0);
      leecher.connectPeer(seeder.listen_port());
      QTimer discovery;
      connect(&discovery, &QTimer::timeout, this, [&] { leecher.connectPeer(seeder.listen_port()); });
      discovery.start(1000);
      QTest::qWait(1500);
      QCOMPARE(leecher.handle().status().total_done, qint64(0));
      leecher.select({videoIndex});
      wp::VerifiedStream stream(leecher);
      QTimer readerDiagnostics;
      connect(&readerDiagnostics, &QTimer::timeout, this, [&] {
        std::vector<lt::alert *> seedAlerts;
        seeder.pop_alerts(&seedAlerts);
        for (auto *alert : seedAlerts)
          qInfo().noquote() << "Seed:" << QString::fromStdString(alert->message());
        QList<int> priorities;
        for (auto priority : leecher.handle().get_file_priorities())
          priorities.append(static_cast<std::uint8_t>(priority));
        qInfo().noquote() << "Reader:" << stream.diagnostics() << "ports=" << seeder.listen_port()
                          << leecher.port() << "peers=" << leecher.peers()
                          << "progress=" << leecher.progress() << "error=" << leecher.error()
                          << "priorities=" << priorities
                          << "finished=" << leecher.handle().status().is_finished
                          << "paused=" << bool(leecher.handle().status().flags & lt::torrent_flags::paused);
      });
      readerDiagnostics.start(2000);
      QNetworkAccessManager network;
      auto bad = stream.url(videoIndex);
      bad.setPath(QStringLiteral("/media/wrong/0"));
      auto *forbidden = network.get(QNetworkRequest(bad));
      QTRY_VERIFY_WITH_TIMEOUT(forbidden->isFinished(), 5000);
      QCOMPARE(forbidden->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 403);
      forbidden->deleteLater();
      const auto manifest = leecher.files();
      const auto excludedFile = std::find_if(manifest.cbegin(), manifest.cend(), [](const auto &f) {
        return f.path.endsWith(QStringLiteral("00-extras.txt"));
      });
      QVERIFY(excludedFile != manifest.cend());
      auto *excluded = network.get(QNetworkRequest(stream.url(excludedFile->index)));
      QTRY_VERIFY_WITH_TIMEOUT(excluded->isFinished(), 5000);
      QCOMPARE(excluded->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 403);
      excluded->deleteLater();
      QNetworkRequest invalid(stream.url(videoIndex));
      invalid.setRawHeader("Range", "bytes=0-1,4-5");
      auto *rejected = network.get(invalid);
      QTRY_VERIFY_WITH_TIMEOUT(rejected->isFinished(), 5000);
      QCOMPARE(rejected->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 416);
      rejected->deleteLater();
      QNetworkRequest request(stream.url(videoIndex));
      request.setRawHeader("Range", "bytes=32770-98320");
      auto *data = network.get(request);
      QTRY_VERIFY_WITH_TIMEOUT(data->isFinished(), 25000);
      QCOMPARE(data->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 206);
      QFile expected(mediaPath);
      QVERIFY(expected.open(QIODevice::ReadOnly));
      QVERIFY(expected.seek(32770));
      QCOMPARE(data->readAll(), expected.read(98320 - 32770 + 1));
      data->deleteLater();
      QVERIFY(stream.cacheBytes() <= 32 * 1024 * 1024);
      wp::Player player(nullptr, true);
      QTimer diagnostics;
      connect(&diagnostics, &QTimer::timeout, this, [&] {
        qInfo().nospace() << "position=" << player.position() << " duration=" << player.duration()
                          << " fileProgress="
                          << double(leecher.handle().file_progress().at(videoIndex)) /
                                 QFileInfo(mediaPath).size()
                          << " served=" << stream.servedBytes() << " requests=" << stream.activeRequests()
                          << " error=" << player.error();
        qInfo().noquote() << stream.diagnostics() << "peers=" << leecher.peers()
                          << "torrentError=" << leecher.error();
        qInfo() << "finished=" << leecher.handle().status().is_finished
                << "paused=" << bool(leecher.handle().status().flags & lt::torrent_flags::paused);
      });
      diagnostics.start(2000);
      player.open(stream.url(videoIndex));
      QTRY_VERIFY_WITH_TIMEOUT(player.loaded(), 30000);
      QTRY_VERIFY_WITH_TIMEOUT(player.position() > 0.5, 15000);
      QVERIFY2(player.error().isEmpty(), qPrintable(player.error()));
      playbackProgress = leecher.progress();
      selectedFileProgress =
          double(leecher.handle().file_progress().at(videoIndex)) / QFileInfo(mediaPath).size();
      QVERIFY2(selectedFileProgress < 0.8,
               "Decoder must start before the selected episode is fully downloaded");
      QVERIFY(player.duration() > 170);
      qInfo("Seeking into missing torrent data at 120 seconds");
      const auto selectedFile = std::find_if(manifest.cbegin(), manifest.cend(),
                                             [videoIndex](const auto &f) { return f.index == videoIndex; });
      QVERIFY(selectedFile != manifest.cend());
      bool missingSeekDataObserved = false;
      auto seekObserver = connect(&stream, &wp::VerifiedStream::waiting, this, [&](int piece) {
        const qint64 relative = qint64(piece) * leecher.pieceLength() - selectedFile->offset;
        if (relative > selectedFile->size / 2 && relative < selectedFile->size * 9 / 10)
          missingSeekDataObserved = true;
      });
      player.seek(120);
      QTRY_VERIFY_WITH_TIMEOUT(player.position() > 120.2 && player.position() < 130, 30000);
      disconnect(seekObserver);
      QVERIFY2(missingSeekDataObserved,
               "The seek must request missing middle-of-episode data, not just play from cache");
      QVERIFY2(player.error().isEmpty(), qPrintable(player.error()));
      player.setPaused(true);
      leecher.pause();
      QTRY_VERIFY_WITH_TIMEOUT(bool(leecher.handle().status().flags & lt::torrent_flags::paused), 5000);
      leecher.checkpoint();
      QTRY_VERIFY_WITH_TIMEOUT(QFile::exists(profile + QStringLiteral("/resume.dat")), 5000);
    }
    {
      wp::TorrentService restored(profile, nullptr, true);
      restored.restore();
      QVERIFY(restored.valid());
      QVERIFY(restored.paused());
      QTRY_VERIFY_WITH_TIMEOUT(!restored.files().isEmpty(), 5000);
      QCOMPARE(restored.files().size(), 3);
      QTest::qWait(300);
      QVERIFY(bool(restored.handle().status().flags & lt::torrent_flags::paused));
      const auto priorities = restored.handle().get_file_priorities();
      for (int i = 0; i < int(priorities.size()); ++i)
        QCOMPARE(priorities[i], i == videoIndex ? lt::default_priority : lt::dont_download);
      restored.resume();
      QVERIFY(!restored.paused());
    }
    QJsonObject result{{QStringLiteral("container"), container},
                       {QStringLiteral("codec"), QStringLiteral("h264")},
                       {QStringLiteral("progressivePlayback"), true},
                       {QStringLiteral("seekIntoMissingData"), true},
                       {QStringLiteral("rangeBytesVerified"), true},
                       {QStringLiteral("manualPauseRestored"), true},
                       {QStringLiteral("selectionRestored"), true},
                       {QStringLiteral("torrentProgressAtPlayback"), playbackProgress},
                       {QStringLiteral("selectedFileProgressAtPlayback"), selectedFileProgress},
                       {QStringLiteral("originalManifestVideoIndex"), videoIndex},
                       {QStringLiteral("qtVersion"), QString::fromLatin1(qVersion())},
                       {QStringLiteral("libtorrentVersion"), QString::fromLatin1(LIBTORRENT_VERSION)}};
    QFile report(root + QStringLiteral("/integration-result.json"));
    QVERIFY(report.open(QIODevice::WriteOnly));
    report.write(QJsonDocument(result).toJson());
    qInfo().noquote() << QJsonDocument(result).toJson(QJsonDocument::Compact);
  }
};
int main(int argc, char **argv) {
  QCoreApplication app(argc, argv);
  wp::configureNativeRuntime();
  Integration test;
  return QTest::qExec(&test, argc, argv);
}
#include "integration.moc"
