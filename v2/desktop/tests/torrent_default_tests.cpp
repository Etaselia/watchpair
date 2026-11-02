#include "../../testing/torrent_fixture.h"
#include "coordinator_fixture.h"
#include "native_runtime.h"
#include "theme.h"
#include "transfer_desk.h"
#include "workspace_pages.h"
#include <QApplication>
#include <QDir>
#include <QFile>
#include <QPointer>
#include <QScrollArea>
#include <QTemporaryDir>
#include <QtTest>
#include <libtorrent/add_torrent_params.hpp>
#include <libtorrent/bencode.hpp>
#include <libtorrent/create_torrent.hpp>
#include <libtorrent/magnet_uri.hpp>
#include <libtorrent/settings_pack.hpp>
#include <libtorrent/torrent_info.hpp>

namespace lt = libtorrent;
namespace {
void write(const QString &path, const QByteArray &bytes) {
  QDir().mkpath(QFileInfo(path).absolutePath());
  QFile file(path);
  if (!file.open(QIODevice::WriteOnly) || file.write(bytes) != bytes.size())
    throw std::runtime_error("Torrent default fixture write failed");
}
QString fixture(const QString &root) {
  write(root + QStringLiteral("/Series/Episode 1.mkv"), QByteArray(512 * 1024, 'a'));
  write(root + QStringLiteral("/Series/Episode 2.mkv"), QByteArray(768 * 1024, 'b'));
  write(root + QStringLiteral("/Series/Extras/Sample.mkv"), QByteArray(16385, 'x'));
  lt::file_storage files;
  lt::add_files(files, (root + QStringLiteral("/Series")).toStdString());
  lt::create_torrent create(files, 64 * 1024, lt::create_torrent::v1_only);
  wp::test::setV1Hashes(create, files, root);
  std::vector<char> bytes;
  lt::bencode(std::back_inserter(bytes), create.generate());
  const auto path = root + QStringLiteral("/series.torrent");
  write(path, QByteArray(bytes.data(), bytes.size()));
  return path;
}
lt::settings_pack seedSettings() {
  lt::settings_pack settings;
  settings.set_str(lt::settings_pack::listen_interfaces, wp::torrentListenInterface(true));
  settings.set_bool(lt::settings_pack::enable_dht, false);
  settings.set_bool(lt::settings_pack::enable_lsd, false);
  settings.set_bool(lt::settings_pack::enable_upnp, false);
  settings.set_bool(lt::settings_pack::enable_natpmp, false);
  settings.set_bool(lt::settings_pack::close_redundant_connections, false);
  return settings;
}
void screenshot(QWidget &widget, const QString &name) {
  const auto output = qEnvironmentVariable("WATCHPAIR_TORRENT_DEFAULT_OUTPUT");
  if (!output.isEmpty()) {
    QDir().mkpath(output);
    widget.grab().save(QDir(output).filePath(name + QStringLiteral(".png")));
  }
}
} // namespace

class TorrentDefaultTests final : public QObject {
  Q_OBJECT
private slots:
  void ownMagnetChooserRespectsRoomAndNewSourceDefaults_data() {
    QTest::addColumn<QString>("roomPolicy");
    QTest::addColumn<QString>("behavior");
    QTest::addColumn<bool>("initialApproval");
    QTest::addColumn<int>("manualApproval");
    QTest::addColumn<bool>("downloads");
    QTest::addColumn<QString>("sourceOverride");
    QTest::addColumn<int>("preparation");
    QTest::newRow("follow-auto") << QStringLiteral("Auto") << QStringLiteral("follow") << true << -1 << true
                                 << QString() << 0;
    QTest::newRow("follow-ask") << QStringLiteral("Ask") << QStringLiteral("follow") << false << -1 << false
                                << QString() << 0;
    QTest::newRow("follow-never") << QStringLiteral("Never") << QStringLiteral("follow") << false << -1
                                  << false << QString() << 0;
    QTest::newRow("auto-overrides-never") << QStringLiteral("Never") << QStringLiteral("auto") << true << -1
                                          << true << QStringLiteral("Auto") << 0;
    QTest::newRow("wait-overrides-auto") << QStringLiteral("Auto") << QStringLiteral("wait") << false << -1
                                         << false << QStringLiteral("Ask") << 0;
    QTest::newRow("explicit-approval-overrides-ask") << QStringLiteral("Ask") << QStringLiteral("follow")
                                                     << false << 1 << true << QStringLiteral("Ask") << 0;
    QTest::newRow("explicit-refusal-overrides-auto") << QStringLiteral("Auto") << QStringLiteral("follow")
                                                     << true << 0 << false << QStringLiteral("Never") << 0;
    QTest::newRow("reused-metadata-auto-overrides-never")
        << QStringLiteral("Never") << QStringLiteral("auto") << true << -1 << true << QStringLiteral("Auto")
        << 1;
    QTest::newRow("reused-metadata-wait-overrides-auto")
        << QStringLiteral("Auto") << QStringLiteral("wait") << false << -1 << false << QStringLiteral("Ask")
        << 1;
    QTest::newRow("cancel-auto-change-to-wait-readd") << QStringLiteral("Auto") << QStringLiteral("wait")
                                                      << false << -1 << false << QStringLiteral("Ask") << 2;
  }
  void ownMagnetChooserRespectsRoomAndNewSourceDefaults() {
    QFETCH(QString, roomPolicy);
    QFETCH(QString, behavior);
    QFETCH(bool, initialApproval);
    QFETCH(int, manualApproval);
    QFETCH(bool, downloads);
    QFETCH(QString, sourceOverride);
    QFETCH(int, preparation);
    try {
      QTemporaryDir tmp;
      QVERIFY(tmp.isValid());
      const auto seedRoot = tmp.filePath(QStringLiteral("seed"));
      const auto metadata = fixture(seedRoot);
      lt::session seeder(seedSettings());
      lt::add_torrent_params params;
      params.ti = std::make_shared<lt::torrent_info>(metadata.toStdString());
      params.save_path = seedRoot.toStdString();
      params.flags &= ~(lt::torrent_flags::auto_managed | lt::torrent_flags::paused);
      params.flags |= lt::torrent_flags::seed_mode;
      auto seed = seeder.add_torrent(params);
      QTRY_VERIFY_WITH_TIMEOUT(seeder.listen_port() > 0 && seed.status().is_seeding, 5000);
      const auto magnet = QString::fromStdString(lt::make_magnet_uri(*params.ti));
      wp::test::Coordinator server;
      server.start(tmp.filePath(QStringLiteral("server.sqlite")));
      wp::AppServices app(tmp.filePath(QStringLiteral("profile")), nullptr, true, true);
      app.transfers.configure({{QStringLiteral("reserveMiB"), 0}, {QStringLiteral("downLimit"), 64 * 1024}});
      app.store.setSetting(QStringLiteral("acquisitionPolicy"), QStringLiteral("Ask"));
      if (behavior != QStringLiteral("follow"))
        app.store.setSetting(QStringLiteral("newTorrentBehavior"), behavior);
      QSignalSpy entered(&app.rooms, &wp::RoomClient::entered);
      app.rooms.create(server.url(), QStringLiteral("Torrent default"), QStringLiteral("Host"));
      QTRY_COMPARE_WITH_TIMEOUT(entered.size(), 1, 5000);
      const auto room = entered.first()[1].toString();
      QTRY_VERIFY_WITH_TIMEOUT(app.rooms.connected(room), 5000);
      app.media.setPolicy(room, roomPolicy);
      QSignalSpy prepared(&app.media, &wp::RoomMedia::prepared);
      QString earlier;
      if (preparation == 1)
        earlier = app.transfers.add(magnet);
      else if (preparation == 2) {
        app.store.setSetting(QStringLiteral("newTorrentBehavior"), QStringLiteral("auto"));
        app.media.prepare(magnet, room);
        QTRY_COMPARE_WITH_TIMEOUT(prepared.size(), 1, 5000);
        earlier = prepared.first()[0].toJsonObject().value(QStringLiteral("transfer")).toString();
        QPointer<wp::ui::TorrentChooser> cancelled = new wp::ui::TorrentChooser(app, earlier, room);
        cancelled->show();
        QVERIFY(cancelled->findChild<QCheckBox *>(QStringLiteral("DownloadOnThisDevice"))->isChecked());
        QTest::keyClick(cancelled, Qt::Key_Escape);
        QTRY_VERIFY(cancelled.isNull());
        prepared.clear();
        app.store.setSetting(QStringLiteral("newTorrentBehavior"), behavior);
      }
      app.media.prepare(magnet, room);
      // Resolution is asynchronous. A later settings save must not change the
      // addition already being inspected, or an existing torrent afterwards.
      app.store.setSetting(QStringLiteral("newTorrentBehavior"), behavior == QStringLiteral("auto")
                                                                     ? QStringLiteral("wait")
                                                                     : QStringLiteral("auto"));
      QTRY_COMPARE_WITH_TIMEOUT(prepared.size(), 1, 5000);
      const auto transfer = prepared.first()[0].toJsonObject().value(QStringLiteral("transfer")).toString();
      if (!earlier.isEmpty()) {
        QCOMPARE(transfer, earlier);
        QCOMPARE(app.transfers.transfers().size(), 1);
      }
      auto *source = app.transfers.source(transfer);
      QVERIFY(source);
      QVERIFY(source->files().isEmpty());
      QTimer peers;
      connect(&peers, &QTimer::timeout, this, [&] {
        app.transfers.connectPeer(transfer, QStringLiteral("127.0.0.1"), seeder.listen_port());
      });
      peers.start(100);
      QTRY_COMPARE_WITH_TIMEOUT(source->files().size(), 3, 15000);
      for (const auto &file : source->files())
        QVERIFY(!source->selected(file.index));
      QCOMPARE(app.transfers.view(transfer).downloaded, qint64(0));
      QPointer<wp::ui::TorrentChooser> chooser = new wp::ui::TorrentChooser(app, transfer, room);
      chooser->show();
      QVERIFY(QTest::qWaitForWindowExposed(chooser));
      auto *download = chooser->findChild<QCheckBox *>(QStringLiteral("DownloadOnThisDevice"));
      auto *apply = chooser->findChild<QPushButton *>(QStringLiteral("ApplySelection"));
      QVERIFY(download && apply);
      QCOMPARE(download->isChecked(), initialApproval);
      if (manualApproval >= 0)
        QTest::mouseClick(download, Qt::LeftButton, Qt::NoModifier, QPoint(10, download->height() / 2));
      QCOMPARE(download->isChecked(), downloads);
      screenshot(*chooser, QString::fromLatin1(QTest::currentDataTag()));
      QTest::mouseClick(apply, Qt::LeftButton);
      QTRY_VERIFY_WITH_TIMEOUT(chooser.isNull(), 5000);
      QTRY_VERIFY_WITH_TIMEOUT(app.store.all(QStringLiteral("publication")).isEmpty(), 5000);
      QTRY_COMPARE_WITH_TIMEOUT(app.rooms.room(room).value(QStringLiteral("entries")).toArray().size(), 3,
                                5000);
      const auto identity = app.transfers.view(transfer).identity;
      const auto decision = app.media.acquisition(room, identity);
      QCOMPARE(decision.value(QStringLiteral("override")).toString(), sourceOverride);
      QCOMPARE(app.media.policy(room), roomPolicy);
      QCOMPARE(app.store.setting(QStringLiteral("acquisitionPolicy")).toString(), QStringLiteral("Ask"));
      QList<int> episodes;
      for (const auto &file : source->files())
        if (!wp::TransferEngine::extra(file.path)) {
          episodes.append(file.index);
          QCOMPARE(source->selected(file.index), downloads);
        } else
          QVERIFY(!source->selected(file.index));
      QCOMPARE(episodes.size(), 2);
      if (downloads)
        QTRY_VERIFY_WITH_TIMEOUT(app.transfers.view(transfer).downloaded > 0, 10000);
      else {
        QTest::qWait(500);
        QCOMPARE(app.transfers.view(transfer).downloaded, qint64(0));
        app.media.reconcile(room);
        for (const int index : episodes)
          QVERIFY(!source->selected(index));
      }
      // Re-opening an existing source uses its explicit approvals or room
      // policy, even though the default for future additions changed above.
      QPointer<wp::ui::TorrentChooser> reopened = new wp::ui::TorrentChooser(app, transfer, room);
      QCOMPARE(reopened->findChild<QCheckBox *>(QStringLiteral("DownloadOnThisDevice"))->isChecked(),
               downloads);
      reopened->show();
      QTest::mouseClick(reopened->findChild<QPushButton *>(QStringLiteral("ApplySelection")), Qt::LeftButton);
      QTRY_VERIFY_WITH_TIMEOUT(reopened.isNull(), 5000);
      QTRY_VERIFY_WITH_TIMEOUT(app.store.all(QStringLiteral("publication")).isEmpty(), 5000);
      const auto unchanged = app.media.acquisition(room, identity);
      QCOMPARE(unchanged.value(QStringLiteral("override")), decision.value(QStringLiteral("override")));
      QCOMPARE(unchanged.value(QStringLiteral("approved")), decision.value(QStringLiteral("approved")));
      app.transfers.setPaused(transfer, true);
      if (!downloads) {
        app.media.approve(room, identity, {wp::RoomMedia::mediaId(identity, episodes.first())});
        QVERIFY(source->selected(episodes.first()));
        QVERIFY(!source->selected(episodes.last()));
        QVERIFY(app.transfers.view(transfer).manualPaused);
        QTest::qWait(200);
        QCOMPARE(app.transfers.view(transfer).downloaded, qint64(0));
        app.transfers.setPaused(transfer, false);
        QTRY_VERIFY_WITH_TIMEOUT(app.transfers.view(transfer).downloaded > 0, 10000);
      } else
        QVERIFY(app.transfers.view(transfer).manualPaused);
      peers.stop();
      app.shutdown();
    } catch (const std::exception &e) {
      QFAIL(e.what());
    }
  }
  void standaloneDownloadRemainsExplicitAndForgottenRoomIsExplained() {
    try {
      QTemporaryDir tmp;
      wp::AppServices app(tmp.filePath(QStringLiteral("profile")), nullptr, true, true);
      app.store.setSetting(QStringLiteral("newTorrentBehavior"), QStringLiteral("wait"));
      QSignalSpy prepared(&app.media, &wp::RoomMedia::prepared);
      app.media.prepare(fixture(tmp.filePath(QStringLiteral("seed"))));
      QTRY_COMPARE_WITH_TIMEOUT(prepared.size(), 1, 5000);
      const auto transfer = prepared.first()[0].toJsonObject().value(QStringLiteral("transfer")).toString();
      auto *source = app.transfers.source(transfer);
      QVERIFY(source && source->files().size() == 3);
      QCOMPARE(app.transfers.view(transfer).downloaded, qint64(0));
      QPointer<wp::ui::TorrentChooser> chooser = new wp::ui::TorrentChooser(app, transfer, {});
      chooser->show();
      QVERIFY(QTest::qWaitForWindowExposed(chooser));
      auto *apply = chooser->findChild<QPushButton *>(QStringLiteral("ApplySelection"));
      QVERIFY(apply && apply->isEnabled());
      QCOMPARE(apply->text(), QStringLiteral("Download selected"));
      QVERIFY(!chooser->findChild<QCheckBox *>(QStringLiteral("DownloadOnThisDevice"))->isVisible());
      QTest::mouseClick(apply, Qt::LeftButton);
      QTRY_VERIFY(chooser.isNull());
      for (const auto &file : source->files())
        QCOMPARE(source->selected(file.index), !wp::TransferEngine::extra(file.path));
      QVERIFY(app.transfers.view(transfer).wanted > 0);
      app.transfers.setPaused(transfer, true);
      const auto choices = app.transfers.intent(transfer).value(QStringLiteral("overrides"));
      QPointer<wp::ui::TorrentChooser> forgotten =
          new wp::ui::TorrentChooser(app, transfer, QStringLiteral("forgotten-room"));
      forgotten->show();
      QVERIFY(!forgotten->findChild<QPushButton *>(QStringLiteral("ApplySelection"))->isEnabled());
      bool explained = false;
      for (const auto *text : forgotten->findChildren<QLabel *>())
        explained |= text->text().contains(QStringLiteral("no longer saved"));
      QVERIFY(explained);
      QCOMPARE(app.transfers.intent(transfer).value(QStringLiteral("overrides")), choices);
      QVERIFY(app.transfers.view(transfer).manualPaused);
      delete forgotten.data();
      app.shutdown();
    } catch (const std::exception &e) {
      QFAIL(e.what());
    }
  }
  void settingsSaveOnlyChangesFutureOwnTorrentDefault() {
    try {
      QTemporaryDir tmp;
      wp::AppServices app(tmp.filePath(QStringLiteral("profile")), nullptr, true, true);
      app.store.setSetting(QStringLiteral("acquisitionPolicy"), QStringLiteral("Never"));
      app.media.setPolicy(QStringLiteral("existing-room"), QStringLiteral("Auto"));
      const auto transfer = app.transfers.add(fixture(tmp.filePath(QStringLiteral("seed"))));
      auto *source = app.transfers.source(transfer);
      QVERIFY(source && !source->files().isEmpty());
      const int first = source->files().first().index;
      app.transfers.select(transfer, {{first, 4}});
      app.transfers.setPaused(transfer, true);
      const auto previous = app.transfers.intent(transfer);
      wp::ui::SettingsPage settings(app);
      settings.resize(1000, 800);
      settings.show();
      auto *behavior = settings.findChild<QComboBox *>(QStringLiteral("NewTorrentBehavior"));
      QVERIFY(behavior);
      QCOMPARE(behavior->count(), 3);
      QCOMPARE(behavior->currentData().toString(), QStringLiteral("follow"));
      behavior->setCurrentIndex(behavior->findData(QStringLiteral("wait")));
      QPushButton *save = nullptr;
      for (auto *button : settings.findChildren<QPushButton *>())
        if (button->text() == QStringLiteral("Save settings"))
          save = button;
      QVERIFY(save);
      QTest::mouseClick(save, Qt::LeftButton);
      QCOMPARE(app.store.setting(QStringLiteral("newTorrentBehavior")).toString(), QStringLiteral("wait"));
      QCOMPARE(app.store.setting(QStringLiteral("acquisitionPolicy")).toString(), QStringLiteral("Never"));
      QCOMPARE(app.media.policy(QStringLiteral("existing-room")), QStringLiteral("Auto"));
      QCOMPARE(app.transfers.intent(transfer).value(QStringLiteral("overrides")),
               previous.value(QStringLiteral("overrides")));
      QCOMPARE(app.transfers.intent(transfer).value(QStringLiteral("choiceRevision")),
               previous.value(QStringLiteral("choiceRevision")));
      QVERIFY(source->selected(first));
      QVERIFY(app.transfers.view(transfer).manualPaused);
      settings.refresh();
      QCOMPARE(behavior->currentData().toString(), QStringLiteral("wait"));
      auto *scroll = settings.findChild<QScrollArea *>();
      QVERIFY(scroll);
      scroll->ensureWidgetVisible(behavior);
      QCoreApplication::processEvents();
      screenshot(settings, QStringLiteral("settings-new-torrents"));
      app.shutdown();
    } catch (const std::exception &e) {
      QFAIL(e.what());
    }
  }
};

int main(int argc, char **argv) {
  QApplication app(argc, argv);
  wp::configureNativeRuntime();
  wp::ui::installTheme();
  TorrentDefaultTests tests;
  return QTest::qExec(&tests, argc, argv);
}
#include "torrent_default_tests.moc"
