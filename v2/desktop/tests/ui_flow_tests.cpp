#include "../../testing/torrent_fixture.h"
#include "coordinator_fixture.h"
#include "main_window.h"
#include "native_runtime.h"
#include "theme.h"
#include <QAbstractItemView>
#include <QApplication>
#include <QComboBox>
#include <QDialogButtonBox>
#include <QFile>
#include <QLabel>
#include <QListWidget>
#include <QProcess>
#include <QMessageBox>
#include <QMenu>
#include <QStatusBar>
#include <QToolButton>
#include <QSurfaceFormat>
#include <QTableWidget>
#include <QTemporaryDir>
#include <QtTest>
#include <libtorrent/bencode.hpp>
#include <libtorrent/create_torrent.hpp>
namespace {
QPushButton *button(QWidget &root, const QString &text) {
  for (auto *b : root.findChildren<QPushButton *>())
    if (b->text() == text && b->isVisible())
      return b;
  return nullptr;
}
void write(const QString &path, const QByteArray &data) {
  QDir().mkpath(QFileInfo(path).absolutePath());
  QFile f(path);
  if (!f.open(QIODevice::WriteOnly) || f.write(data) != data.size())
    throw std::runtime_error("Fixture write failed");
}
QString pack(const QString &root) {
  for (int season = 1; season <= 2; ++season)
    for (int episode = 1; episode <= 6; ++episode)
      write(root + QStringLiteral("/Skyline Stories/Season %1/Episode %2.mkv")
                       .arg(season)
                       .arg(episode, 2, 10, QLatin1Char('0')),
            QByteArray(65537, char(episode)));
  write(root + QStringLiteral("/Skyline Stories/Extras/Sample.mkv"), QByteArray(16000, 'x'));
  libtorrent::file_storage files;
  libtorrent::add_files(files, (root + QStringLiteral("/Skyline Stories")).toStdString());
  libtorrent::create_torrent create(files, 65536, libtorrent::create_torrent::v1_only);
  wp::test::setV1Hashes(create, files, root);
  std::vector<char> out;
  libtorrent::bencode(std::back_inserter(out), create.generate());
  const auto path = root + QStringLiteral("/pack.torrent");
  write(path, QByteArray(out.data(), out.size()));
  return path;
}
void screenshot(QWidget &window, const QString &name) {
  const auto root = qEnvironmentVariable("WATCHPAIR_UI_OUTPUT");
  if (root.isEmpty())
    return;
  QDir().mkpath(root);
  window.grab().save(QDir(root).filePath(name + QStringLiteral(".png")));
}
void chooseOption(QComboBox *box, int index) {
  box->showPopup();
  auto *view = box->view();
  QTest::mouseClick(view->viewport(), Qt::LeftButton, Qt::NoModifier,
                    view->visualRect(box->model()->index(index, 0)).center());
}
} // namespace
class UiFlowTests final : public QObject {
  Q_OBJECT
private slots:
  void followsTheSeasonFromWatchedAndRestartsAStoppedRule() {
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    wp::test::Coordinator server;
    server.start(tmp.filePath(QStringLiteral("server.sqlite")), true);
    wp::AppServices services(tmp.filePath(QStringLiteral("profile")), nullptr, true, false);
    services.rooms.setSeriesFallbackEnabled(false);
    services.store.setSetting(QStringLiteral("acquisitionPolicy"), QStringLiteral("Never"));
    QSignalSpy entered(&services.rooms, &wp::RoomClient::entered);
    services.rooms.create(server.url(), QStringLiteral("Season review"), QStringLiteral("Host"));
    QTRY_COMPARE_WITH_TIMEOUT(entered.size(), 1, 5000);
    const auto room = entered.first()[1].toString();
    QTRY_VERIFY_WITH_TIMEOUT(services.rooms.connected(room), 5000);
    const auto hash = QStringLiteral("2de4432a3db4367d8f643224fa761f353c2dd0ea");
    const QJsonObject source{{QStringLiteral("id"), QStringLiteral("fixture-torrent")},
                             {QStringLiteral("kind"), QStringLiteral("torrent")},
                             {QStringLiteral("label"), QStringLiteral("Test Anime")},
                             {QStringLiteral("uri"), QStringLiteral("magnet:?xt=urn:btih:") + hash},
                             {QStringLiteral("identity"), QStringLiteral("bt:") + hash}};
    const QJsonObject file{{QStringLiteral("mediaId"), QStringLiteral("fixture-episode")},
                           {QStringLiteral("path"), QStringLiteral("[Origin] Test Anime - 07 (1080p).mkv")},
                           {QStringLiteral("label"), QStringLiteral("Test Anime 7")},
                           {QStringLiteral("fileIndex"), 0}, {QStringLiteral("size"), 123},
                           {QStringLiteral("selected"), true}};
    services.rooms.command(room, {{QStringLiteral("type"), QStringLiteral("queue.add")},
                                  {QStringLiteral("source"), source}, {QStringLiteral("files"), QJsonArray{file}}});
    const auto entries = [&] { return services.rooms.room(room).value(QStringLiteral("entries")).toArray(); };
    QTRY_COMPARE_WITH_TIMEOUT(entries().size(), 1, 5000);
    const auto entryId = entries().first().toObject().value(QStringLiteral("id"));
    services.rooms.command(room, {{QStringLiteral("type"), QStringLiteral("history.mark")},
                                  {QStringLiteral("ids"), QJsonArray{entryId}}, {QStringLiteral("watched"), true}});
    QTRY_VERIFY_WITH_TIMEOUT(entries().first().toObject().value(QStringLiteral("watchedAt")).isDouble(), 5000);
    wp::ui::MainWindow window(services);
    window.show();
    window.showRoom(room);
    QVERIFY(QTest::qWaitForWindowExposed(&window));
    auto *tabs = window.findChild<QTabBar *>(QStringLiteral("QueueTabs"));
    auto *seasonButton = window.findChild<QPushButton *>(QStringLiteral("QueueFollowSeason"));
    QVERIFY(tabs && seasonButton);
    QVERIFY(!seasonButton->isVisible());
    tabs->setCurrentIndex(1);
    QTRY_VERIFY_WITH_TIMEOUT(seasonButton->isVisible() && seasonButton->isEnabled(), 5000);
    QTest::mouseClick(seasonButton, Qt::LeftButton);
    auto *dialog = window.findChild<QDialog *>(QStringLiteral("SeasonFollowDialog"));
    QVERIFY(dialog);
    auto *table = dialog->findChild<QTableWidget *>(QStringLiteral("SeasonFollowTable"));
    auto *confirm = dialog->findChild<QPushButton *>(QStringLiteral("ConfirmSeasonFollows"));
    QVERIFY(table && confirm);
    QTRY_VERIFY_WITH_TIMEOUT(confirm->isEnabled(), 5000);
    QCOMPARE(table->rowCount(), 1);
    QCOMPARE(table->item(0, 1)->text(), QStringLiteral("7"));
    QVERIFY(table->item(0, 2)->text().contains(QStringLiteral("Next episode 8")));
    QTest::mouseClick(confirm, Qt::LeftButton);
    QTRY_VERIFY_WITH_TIMEOUT(table->item(0, 2)->text().contains(QStringLiteral("Follow saved")), 5000);
    QCOMPARE(entries().size(), 1);
    dialog->reject();
    QVERIFY(server.checkSeries());
    QJsonObject stopped;
    services.rooms.loadSeriesFollows(room, &window, [&](const QJsonObject &response, const QString &error) {
      QVERIFY(error.isEmpty());
      const auto rule = response.value(QStringLiteral("items")).toArray().first().toObject();
      services.rooms.seriesFollowAction(room, rule.value(QStringLiteral("id")).toString(),
          {{QStringLiteral("action"), QStringLiteral("stop")}, {QStringLiteral("revision"), rule.value(QStringLiteral("revision"))}},
          &window, [&](const QJsonObject &result, const QString &failure) {
            QVERIFY(failure.isEmpty());
            stopped = result.value(QStringLiteral("item")).toObject();
          });
    });
    QTRY_COMPARE_WITH_TIMEOUT(stopped.value(QStringLiteral("status")).toString(), QStringLiteral("stopped"), 5000);
    window.findChild<QPushButton *>(QStringLiteral("RoomSeriesFollows"))->click();
    auto *manager = window.findChild<QDialog *>(QStringLiteral("SeriesManagerDialog"));
    QVERIFY(manager);
    QTRY_VERIFY_WITH_TIMEOUT(button(*manager, QStringLiteral("Follow again")) &&
                            button(*manager, QStringLiteral("Follow again"))->isEnabled(), 5000);
    QTest::mouseClick(button(*manager, QStringLiteral("Follow again")), Qt::LeftButton);
    QTRY_VERIFY_WITH_TIMEOUT(button(*manager, QStringLiteral("Pause")) &&
                            button(*manager, QStringLiteral("Pause"))->isEnabled(), 5000);
    QCOMPARE(manager->findChild<QListWidget *>(QStringLiteral("SeriesFollowList"))->count(), 1);
    window.prepareToQuit();
    services.shutdown();
  }

  void followSeriesFromRoomAndApproveAlternate() {
    try {
      QTemporaryDir tmp;
      QVERIFY(tmp.isValid());
      wp::test::Coordinator server;
      server.start(tmp.filePath(QStringLiteral("server.sqlite")), true);
      wp::AppServices services(tmp.filePath(QStringLiteral("profile")), nullptr, true, false);
      services.rooms.setSeriesFallbackEnabled(false);
      services.store.setSetting(QStringLiteral("acquisitionPolicy"), QStringLiteral("Never"));
      QSignalSpy entered(&services.rooms, &wp::RoomClient::entered);
      services.rooms.create(server.url(), QStringLiteral("Series room"), QStringLiteral("Host"));
      QTRY_COMPARE_WITH_TIMEOUT(entered.size(), 1, 5000);
      const auto room = entered.first()[1].toString();
      QTRY_VERIFY_WITH_TIMEOUT(services.rooms.connected(room), 5000);
      wp::ui::MainWindow window(services);
      window.show();
      window.showRoom(room);
      QVERIFY(QTest::qWaitForWindowExposed(&window));
      auto *roomSeries = window.findChild<QPushButton *>(QStringLiteral("RoomSeriesFollows"));
      QVERIFY(roomSeries);
      QTRY_VERIFY_WITH_TIMEOUT(roomSeries->isVisible() && roomSeries->isEnabled(), 5000);
      QTest::mouseClick(roomSeries, Qt::LeftButton);
      auto *manager = window.findChild<QDialog *>(QStringLiteral("SeriesManagerDialog"));
      QVERIFY(manager);
      QTRY_VERIFY_WITH_TIMEOUT(button(*manager, QStringLiteral("Follow a series…")) &&
                                   button(*manager, QStringLiteral("Follow a series…"))->isEnabled(),
                               5000);
      QTest::mouseClick(button(*manager, QStringLiteral("Follow a series…")), Qt::LeftButton);
      QPointer<QDialog> follow = manager->findChild<QDialog *>(QStringLiteral("SeriesFollowDialog"));
      QVERIFY(follow);
      auto *query = follow->findChild<QLineEdit *>(QStringLiteral("SeriesSearchInput"));
      auto *search = follow->findChild<QPushButton *>(QStringLiteral("SeriesSearch"));
      auto *season = follow->findChild<QComboBox *>(QStringLiteral("SeriesCatalogChoice"));
      auto *release = follow->findChild<QComboBox *>(QStringLiteral("SeriesReleaseChoice"));
      auto *confirm = button(*follow, QStringLiteral("Follow series"));
      QVERIFY(query && search && season && release && confirm);
      QVERIFY(!confirm->isEnabled());
      QTest::keyClicks(query, QStringLiteral("Test Anime"));
      QTest::mouseClick(search, Qt::LeftButton);
      QTRY_VERIFY_WITH_TIMEOUT(season->isVisible() && season->isEnabled() && season->count() == 2, 5000);
      chooseOption(season, 1);
      QTRY_VERIFY_WITH_TIMEOUT(release->isVisible() && release->isEnabled() && release->count() == 3, 5000);
      QCOMPARE(season->currentText(), QStringLiteral("Test Anime"));
      chooseOption(release, 1);
      QTRY_VERIFY_WITH_TIMEOUT(confirm->isEnabled(), 5000);
      QVERIFY(release->currentText().contains(QStringLiteral(" - 07 ")));
      screenshot(*follow, QStringLiteral("series-confirmation"));
      QTest::mouseClick(confirm, Qt::LeftButton);
      QTRY_VERIFY_WITH_TIMEOUT(!follow, 5000);
      auto *list = manager->findChild<QListWidget *>(QStringLiteral("SeriesFollowList"));
      QVERIFY(list);
      const auto available = [manager](const QString &label) {
        const auto *control = button(*manager, label);
        return control && control->isEnabled();
      };
      QTRY_COMPARE_WITH_TIMEOUT(list->count(), 1, 5000);
      QVERIFY(list->currentItem()->text().contains(QStringLiteral("Pending · Verifying starting release")));
      QTRY_COMPARE_WITH_TIMEOUT(roomSeries->text(), QStringLiteral("Series follows · Pending"), 5000);
      QCOMPARE(services.rooms.room(room).value(QStringLiteral("entries")).toArray().size(), 0);
      QVERIFY(!available(QStringLiteral("Check now")));
      QLabel *pendingDetails = nullptr;
      for (auto *label : manager->findChildren<QLabel *>()) {
        if (label->text().contains(QStringLiteral("Next verification attempt:"))) {
          pendingDetails = label;
          break;
        }
      }
      QVERIFY(pendingDetails);
      QTRY_VERIFY_WITH_TIMEOUT(pendingDetails->isVisible() &&
                                   pendingDetails->height() >= pendingDetails->heightForWidth(pendingDetails->width()),
                               5000);
      screenshot(*manager, QStringLiteral("series-pending"));

      QSignalSpy seriesChanged(&services.rooms, &wp::RoomClient::seriesFollowsChanged);
      QVERIFY(server.checkSeries());
      QTRY_COMPARE_WITH_TIMEOUT(services.rooms.room(room).value(QStringLiteral("entries")).toArray().size(), 1, 5000);
      const auto followState = [&] {
        return QStringLiteral("Notifications=%1, connection=%2, manager visible=%3, selected row=%4")
            .arg(seriesChanged.size())
            .arg(services.rooms.connectionState(room))
            .arg(manager->isVisible())
            .arg(list->currentItem() ? list->currentItem()->text() : QStringLiteral("None"));
      };
      QTRY_VERIFY2_WITH_TIMEOUT(available(QStringLiteral("Check now")), qPrintable(followState()), 5000);
      QVERIFY(!list->currentItem()->text().contains(QStringLiteral("Pending")));
      QTRY_COMPARE_WITH_TIMEOUT(roomSeries->text(), QStringLiteral("Series follows"), 5000);
      QTRY_VERIFY_WITH_TIMEOUT(available(QStringLiteral("Pause")), 5000);
      QCOMPARE(list->count(), 1);
      QTest::mouseClick(button(*manager, QStringLiteral("Pause")), Qt::LeftButton);
      QTRY_VERIFY_WITH_TIMEOUT(available(QStringLiteral("Resume")), 5000);
      QVERIFY(list->currentItem()->text().contains(QStringLiteral("Paused")));
      QTest::mouseClick(button(*manager, QStringLiteral("Resume")), Qt::LeftButton);
      QTRY_VERIFY_WITH_TIMEOUT(available(QStringLiteral("Check now")), 5000);
      QTest::mouseClick(button(*manager, QStringLiteral("Check now")), Qt::LeftButton);
      QTRY_VERIFY_WITH_TIMEOUT(available(QStringLiteral("Refresh")), 5000);
      QVERIFY(server.checkSeries());
      QTRY_VERIFY_WITH_TIMEOUT(available(QStringLiteral("Use this release once")), 5000);
      screenshot(*manager, QStringLiteral("series-host-review"));
      QTimer::singleShot(0, &window, [] {
        if (auto *question = qobject_cast<QMessageBox *>(QApplication::activeModalWidget()))
          question->button(QMessageBox::Yes)->click();
      });
      QTest::mouseClick(button(*manager, QStringLiteral("Use this release once")), Qt::LeftButton);
      QTRY_COMPARE_WITH_TIMEOUT(services.rooms.room(room).value(QStringLiteral("entries")).toArray().size(), 2, 5000);
      QTRY_VERIFY_WITH_TIMEOUT(!button(*manager, QStringLiteral("Use this release once")), 5000);
      for (const auto &transfer : services.transfers.transfers())
        QCOMPARE(transfer.wanted, 0);
      window.prepareToQuit();
      services.shutdown();
    } catch (const std::exception &e) {
      QFAIL(e.what());
    }
  }

  void followAnExistingWatchedEpisodeWithoutRequeuingIt() {
    try {
      QTemporaryDir tmp;
      QVERIFY(tmp.isValid());
      wp::test::Coordinator server;
      server.start(tmp.filePath(QStringLiteral("server.sqlite")), true);
      wp::AppServices services(tmp.filePath(QStringLiteral("profile")), nullptr, true, false);
      services.rooms.setSeriesFallbackEnabled(false);
      services.store.setSetting(QStringLiteral("acquisitionPolicy"), QStringLiteral("Never"));
      QSignalSpy entered(&services.rooms, &wp::RoomClient::entered);
      services.rooms.create(server.url(), QStringLiteral("Existing episode"), QStringLiteral("Host"));
      QTRY_COMPARE_WITH_TIMEOUT(entered.size(), 1, 5000);
      const auto room = entered.first()[1].toString();
      QTRY_VERIFY_WITH_TIMEOUT(services.rooms.connected(room), 5000);
      const QJsonObject source{{QStringLiteral("id"), QStringLiteral("existing-source")},
                               {QStringLiteral("kind"), QStringLiteral("direct")},
                               {QStringLiteral("label"), QStringLiteral("Existing source")},
                               {QStringLiteral("uri"), server.url() + QStringLiteral("/episode.mkv")},
                               {QStringLiteral("identity"), QStringLiteral("existing-source")}};
      const QJsonObject file{{QStringLiteral("mediaId"), QStringLiteral("existing-episode")},
                             {QStringLiteral("path"), QStringLiteral("Season/Test Anime - 07 (1080p).mkv")},
                             {QStringLiteral("label"), QStringLiteral("Our episode title")},
                             {QStringLiteral("fileIndex"), 0}, {QStringLiteral("size"), 123},
                             {QStringLiteral("selected"), true}};
      services.rooms.command(room, {{QStringLiteral("type"), QStringLiteral("queue.add")},
                                    {QStringLiteral("source"), source},
                                    {QStringLiteral("files"), QJsonArray{file}}});
      QTRY_COMPARE_WITH_TIMEOUT(services.rooms.room(room).value(QStringLiteral("entries")).toArray().size(), 1, 5000);
      const auto entryId = services.rooms.room(room).value(QStringLiteral("entries")).toArray().first().toObject()
                               .value(QStringLiteral("id")).toString();
      wp::ui::MainWindow window(services);
      window.show();
      window.showRoom(room);
      QVERIFY(QTest::qWaitForWindowExposed(&window));
      auto *queue = window.findChild<QTableView *>(QStringLiteral("EpisodeQueue"));
      auto *history = window.findChild<QTableView *>(QStringLiteral("WatchedHistory"));
      auto *tabs = window.findChild<QTabBar *>(QStringLiteral("QueueTabs"));
      auto *more = window.findChild<QToolButton *>(QStringLiteral("QueueMore"));
      auto *mark = window.findChild<QPushButton *>(QStringLiteral("QueueMarkWatched"));
      QVERIFY(queue && history && tabs && more && mark);
      auto *action = more->menu()->findChild<QAction *>(QStringLiteral("QueueFollowSeries"));
      QVERIFY(action);
      QTRY_VERIFY_WITH_TIMEOUT(services.rooms.seriesFollowFromEntryAvailable(room), 5000);
      QTRY_COMPARE(queue->model()->rowCount(), 1);
      queue->selectRow(0);
      QVERIFY(action->isVisible() && action->isEnabled());
      QTest::mouseClick(mark, Qt::LeftButton);
      QTRY_VERIFY_WITH_TIMEOUT(services.rooms.entry(room, entryId).value(QStringLiteral("watchedAt")).isDouble(), 5000);
      tabs->setCurrentIndex(1);
      QTRY_COMPARE(history->model()->rowCount(), 1);
      history->selectRow(0);
      QVERIFY(action->isVisible() && action->isEnabled());
      const auto revision = services.rooms.room(room).value(QStringLiteral("queueRevision"));
      const auto original = services.rooms.entry(room, entryId);

      action->trigger();
      QPointer<QDialog> follow = window.findChild<QDialog *>(QStringLiteral("SeriesFollowDialog"));
      QVERIFY(follow);
      auto *season = follow->findChild<QComboBox *>(QStringLiteral("SeriesCatalogChoice"));
      auto *release = follow->findChild<QComboBox *>(QStringLiteral("SeriesReleaseChoice"));
      auto *confirm = button(*follow, QStringLiteral("Follow series"));
      auto *preview = follow->findChild<QLabel *>(QStringLiteral("SeriesPreview"));
      QVERIFY(season && release && confirm && preview);
      QTRY_VERIFY_WITH_TIMEOUT(season->isVisible() && season->isEnabled() && season->count() == 2, 5000);
      chooseOption(season, 1);
      QTRY_VERIFY_WITH_TIMEOUT(release->isVisible() && release->isEnabled() && release->count() == 2, 5000);
      chooseOption(release, 1);
      QTRY_VERIFY_WITH_TIMEOUT(confirm->isEnabled(), 5000);
      QVERIFY(preview->text().contains(QStringLiteral("Next episode: 8")));
      QTest::mouseClick(confirm, Qt::LeftButton);
      QTRY_VERIFY_WITH_TIMEOUT(!follow, 5000);
      QVERIFY(window.statusBar()->currentMessage().contains(QStringLiteral("Follow saved")));
      QJsonArray rules;
      services.rooms.loadSeriesFollows(room, &window, [&](const QJsonObject &result, const QString &) {
        rules = result.value(QStringLiteral("items")).toArray();
      });
      QTRY_COMPARE_WITH_TIMEOUT(rules.size(), 1, 5000);
      QCOMPARE(rules.first().toObject().value(QStringLiteral("pending")).toString(), QStringLiteral("setup"));
      QVERIFY(server.checkSeries());
      rules = {};
      services.rooms.loadSeriesFollows(room, &window, [&](const QJsonObject &result, const QString &) {
        rules = result.value(QStringLiteral("items")).toArray();
      });
      QTRY_COMPARE_WITH_TIMEOUT(rules.size(), 1, 5000);
      QVERIFY(rules.first().toObject().value(QStringLiteral("pending")).isNull());
      QCOMPARE(rules.first().toObject().value(QStringLiteral("nextEpisode")).toInt(), 8);
      const auto roomId = services.rooms.credential(room).value(QStringLiteral("roomId")).toString();
      QCOMPARE(server.inspect(roomId).value(QStringLiteral("entries")).toArray().size(), 1);
      QCOMPARE(services.rooms.room(room).value(QStringLiteral("queueRevision")), revision);
      QCOMPARE(services.rooms.entry(room, entryId), original);
      QCOMPARE(queue->model()->rowCount(), 0);
      QCOMPARE(history->model()->rowCount(), 1);
      window.prepareToQuit();
      services.shutdown();
    } catch (const std::exception &e) {
      QFAIL(e.what());
    }
  }

  void duplicateEpisodeNamesUseSelectedStableIdsAndTabSpecificActions() {
    try {
      QTemporaryDir tmp;
      wp::test::Coordinator server;
      server.start(tmp.filePath(QStringLiteral("server.sqlite")));
      wp::AppServices services(tmp.filePath(QStringLiteral("profile")), nullptr, true, false);
      QSignalSpy roomErrors(&services.rooms, &wp::RoomClient::error);
      QSignalSpy operations(&services.rooms, &wp::RoomClient::operationComplete);
      services.store.setSetting(QStringLiteral("acquisitionPolicy"), QStringLiteral("Never"));
      services.transfers.configure({{QStringLiteral("reserveMiB"), 0}});
      QSignalSpy entered(&services.rooms, &wp::RoomClient::entered);
      services.rooms.create(server.url(), QStringLiteral("Duplicate episode names"), QStringLiteral("Host"));
      QTRY_COMPARE_WITH_TIMEOUT(entered.size(), 1, 5000);
      const auto room = entered.first()[1].toString();
      QTRY_VERIFY_WITH_TIMEOUT(services.rooms.connected(room), 5000);
      const auto root = tmp.filePath(QStringLiteral("pack"));
      const auto transfer = services.transfers.add(pack(root), tmp.filePath(QStringLiteral("downloads")));
      QTRY_VERIFY_WITH_TIMEOUT(services.transfers.source(transfer) &&
          services.transfers.source(transfer)->files().size() == 13, 5000);
      QList<int> files;
      for (const auto &file : services.transfers.source(transfer)->files())
        if (!file.path.contains(QStringLiteral("Extras/"))) files.append(file.index);
      services.media.publishTorrent(transfer, room, files, false, false);
      QTRY_COMPARE_WITH_TIMEOUT(services.rooms.room(room).value(QStringLiteral("entries")).toArray().size(), 13, 5000);
      wp::ui::RoomPage page(services);
      page.resize(1250, 850);
      page.setRoom(room);
      page.show();
      QVERIFY(QTest::qWaitForWindowExposed(&page));
      QVERIFY(page.findChild<QPushButton *>(QStringLiteral("RoomSeriesFollows"))->isHidden());
      auto *queue = page.findChild<QTableView *>(QStringLiteral("EpisodeQueue"));
      auto *history = page.findChild<QTableView *>(QStringLiteral("WatchedHistory"));
      auto *search = page.findChild<QLineEdit *>(QStringLiteral("queueSearch"));
      auto *tabs = page.findChild<QTabBar *>(QStringLiteral("QueueTabs"));
      auto *more = page.findChild<QToolButton *>(QStringLiteral("QueueMore"));
      QVERIFY(queue && history && search && tabs && more);
      auto *mark = page.findChild<QPushButton *>(QStringLiteral("QueueMarkWatched"));
      QVERIFY(mark);
      QSignalSpy markClicks(mark, &QPushButton::clicked);
      QJsonArray submittedCommands;
      connect(mark, &QPushButton::clicked, &page, [&] {
        // RoomPage's earlier clicked connection synchronously stores the
        // command. Capture its original envelope before an asynchronous ack.
        for (const auto value : services.store.all(QStringLiteral("room-command"))) {
          const auto row = value.toObject();
          const auto envelope = row.value(QStringLiteral("envelope")).toObject();
          const auto command = envelope.value(QStringLiteral("command")).toObject();
          if (command.value(QStringLiteral("type")).toString() == QStringLiteral("history.mark"))
            submittedCommands.append(QJsonObject{{QStringLiteral("operation"), row.value(QStringLiteral("id"))},
                                                 {QStringLiteral("command"), command},
                                                 {QStringLiteral("queueRevision"), envelope.value(QStringLiteral("queueRevision"))}});
        }
      });
      auto queueDiagnostics = [&] {
        QJsonArray selection, errors, completed, commands;
        for (const auto &index : queue->selectionModel()->selectedRows())
          selection.append(index.data(wp::ui::IdRole).toString());
        for (const auto &arguments : roomErrors)
          errors.append(QJsonObject{{QStringLiteral("code"), arguments[1].toString()},
                                    {QStringLiteral("message"), arguments[2].toString()},
                                    {QStringLiteral("operation"), arguments[3].toString()}});
        for (const auto &arguments : operations)
          completed.append(arguments[1].toString());
        for (const auto value : services.store.all(QStringLiteral("room-command"))) {
          const auto row = value.toObject();
          const auto envelope = row.value(QStringLiteral("envelope")).toObject();
          const auto command = envelope.value(QStringLiteral("command")).toObject();
          commands.append(QJsonObject{{QStringLiteral("operation"), row.value(QStringLiteral("id"))},
                                      {QStringLiteral("state"), row.value(QStringLiteral("state"))},
                                      {QStringLiteral("error"), row.value(QStringLiteral("error"))},
                                      {QStringLiteral("type"), command.value(QStringLiteral("type"))},
                                      {QStringLiteral("ids"), command.value(QStringLiteral("ids"))},
                                      {QStringLiteral("queueRevision"), envelope.value(QStringLiteral("queueRevision"))}});
        }
        const auto row = queue->visualRect(queue->model()->index(1, 0));
        return QJsonDocument(QJsonObject{
            {QStringLiteral("connected"), services.rooms.connected(room)},
            {QStringLiteral("connection"), services.rooms.connectionState(room)},
            {QStringLiteral("rows"), queue->model()->rowCount()},
            {QStringLiteral("selection"), selection},
            {QStringLiteral("markEnabled"), mark->isEnabled()},
            {QStringLiteral("markVisible"), mark->isVisible()},
            {QStringLiteral("markClicks"), markClicks.size()},
            {QStringLiteral("rowRect"), QStringLiteral("%1,%2 %3x%4").arg(row.x()).arg(row.y()).arg(row.width()).arg(row.height())},
            {QStringLiteral("viewport"), QStringLiteral("%1x%2").arg(queue->viewport()->width()).arg(queue->viewport()->height())},
            {QStringLiteral("queueRevision"), services.rooms.room(room).value(QStringLiteral("queueRevision"))},
            {QStringLiteral("submitted"), submittedCommands},
            {QStringLiteral("commands"), commands},
            {QStringLiteral("errors"), errors},
            {QStringLiteral("completed"), completed},
            {QStringLiteral("activity"), services.activity()}}).toJson(QJsonDocument::Compact);
      };
      // Showing a native renderer can take long enough for the room heartbeat
      // to reconnect. Verify this precondition again after exposure.
      QTRY_VERIFY2_WITH_TIMEOUT(services.rooms.connected(room), queueDiagnostics().constData(), 5000);
      search->setText(QStringLiteral("Episode 01"));
      QTRY_COMPARE(queue->model()->rowCount(), 2);
      const auto firstId = queue->model()->index(0, 0).data(wp::ui::IdRole).toString();
      const auto secondId = queue->model()->index(1, 0).data(wp::ui::IdRole).toString();
      QVERIFY(firstId != secondId);
      QVERIFY(services.rooms.entry(room, firstId).value(QStringLiteral("path")).toString().contains(QStringLiteral("Season 1/")));
      QVERIFY(services.rooms.entry(room, secondId).value(QStringLiteral("path")).toString().contains(QStringLiteral("Season 2/")));
      queue->doItemsLayout();
      queue->scrollTo(queue->model()->index(1, 0), QAbstractItemView::PositionAtCenter);
      QCoreApplication::processEvents();
      QTRY_VERIFY2_WITH_TIMEOUT(!queue->visualRect(queue->model()->index(1, 0)).isEmpty() &&
          queue->viewport()->rect().contains(queue->visualRect(queue->model()->index(1, 0))),
          queueDiagnostics().constData(), 1000);
      QCOMPARE(queue->model()->index(1, 0).data(wp::ui::IdRole).toString(), secondId);
      QTest::mouseClick(queue->viewport(), Qt::LeftButton, Qt::NoModifier,
                        queue->visualRect(queue->model()->index(1, 0)).center());
      QVERIFY2(queue->selectionModel()->selectedRows().size() == 1, queueDiagnostics().constData());
      QCOMPARE(queue->selectionModel()->selectedRows().first().data(wp::ui::IdRole).toString(), secondId);
      QVERIFY2(mark->isVisible() && mark->isEnabled() && services.rooms.connected(room), queueDiagnostics().constData());
      qInfo("Mark watched before click: %s", queueDiagnostics().constData());
      QTest::mouseClick(mark, Qt::LeftButton);
      qInfo("Mark watched after click: %s", queueDiagnostics().constData());
      QVERIFY2(markClicks.size() == 1, queueDiagnostics().constData());
      QTRY_VERIFY2_WITH_TIMEOUT(queue->model()->rowCount() == 1, queueDiagnostics().constData(), 5000);
      QCOMPARE(queue->model()->index(0, 0).data(wp::ui::IdRole).toString(), firstId);
      QVERIFY(services.rooms.entry(room, firstId).value(QStringLiteral("watchedAt")).isNull());
      QVERIFY(services.rooms.entry(room, secondId).value(QStringLiteral("watchedAt")).isDouble());
      QTRY_COMPARE_WITH_TIMEOUT(history->model()->rowCount(), 1, 5000);
      QVERIFY(history->model()->index(0, 0).data().toString().contains(QStringLiteral("Season 2")));
      QCOMPARE(history->model()->index(0, 1).data().toString(), QStringLiteral("just now"));
      QTest::mouseClick(queue->viewport(), Qt::LeftButton, Qt::NoModifier,
                        queue->visualRect(queue->model()->index(0, 0)).center());
      QVERIFY(!page.findChild<QPushButton *>(QStringLiteral("QueueApproveDownloads")));
      const auto action = queue->model()->index(0, 4);
      QVERIFY(action.data(wp::ui::ApprovalRole).toBool());
      QCOMPARE(action.data().toString(), QStringLiteral("Download"));
      queue->scrollTo(action);
      QCoreApplication::processEvents();
      screenshot(page, QStringLiteral("queue-inline-download"));
      const auto queueRevision = services.rooms.room(room).value(QStringLiteral("queueRevision"));
      const auto actionPoint = queue->visualRect(action).center();
      const auto titlePoint = queue->visualRect(queue->model()->index(0, 0)).center();
      QTest::mousePress(queue->viewport(), Qt::LeftButton, Qt::NoModifier, actionPoint);
      QTest::mouseRelease(queue->viewport(), Qt::LeftButton, Qt::NoModifier, titlePoint);
      QTest::mousePress(queue->viewport(), Qt::LeftButton, Qt::NoModifier, titlePoint);
      QTest::mouseRelease(queue->viewport(), Qt::LeftButton, Qt::NoModifier, actionPoint);
      const auto unapproved = services.rooms.entry(room, firstId);
      QVERIFY(!services.media.acquisition(room, unapproved.value(QStringLiteral("sourceId")).toString())
          .value(QStringLiteral("approved")).toArray().contains(unapproved.value(QStringLiteral("mediaId"))));
      QVERIFY(queue->model()->index(0, 4).data(wp::ui::ApprovalRole).toBool());
      // A single row click approves exactly this episode, with no modal step.
      QTest::mouseClick(queue->viewport(), Qt::LeftButton, Qt::NoModifier,
                        queue->visualRect(action).center());
      const auto first = services.rooms.entry(room, firstId), second = services.rooms.entry(room, secondId);
      const auto source = first.value(QStringLiteral("sourceId")).toString();
      const auto acquisition = services.media.acquisition(room, source);
      QVERIFY(acquisition.value(QStringLiteral("approved")).toArray().contains(first.value(QStringLiteral("mediaId"))));
      QVERIFY(!acquisition.value(QStringLiteral("approved")).toArray().contains(second.value(QStringLiteral("mediaId"))));
      QCOMPARE(services.rooms.room(room).value(QStringLiteral("queueRevision")), queueRevision);
      QTRY_VERIFY(services.transfers.source(transfer)->selected(first.value(QStringLiteral("fileIndex")).toInt()));
      QVERIFY(!services.transfers.source(transfer)->selected(second.value(QStringLiteral("fileIndex")).toInt()));
      QVERIFY(!page.findChild<QMessageBox *>(QStringLiteral("QueueDownloadApproval")));
      QTRY_VERIFY(!queue->model()->index(0, 4).data(wp::ui::ApprovalRole).toBool());
      QVERIFY(queue->model()->index(0, 4).data().toString().isEmpty());
      QTest::mouseClick(queue->viewport(), Qt::LeftButton, Qt::NoModifier,
                        queue->visualRect(queue->model()->index(0, 4)).center());
      QCOMPARE(services.media.acquisition(room, source).value(QStringLiteral("decisionRevision")),
               acquisition.value(QStringLiteral("decisionRevision")));
      // Keyboard activation also targets its own stable row without approval elsewhere.
      const auto filter = search->text();
      search->clear();
      QModelIndex keyboard;
      for (int row = 0; row < queue->model()->rowCount(); ++row)
        if (queue->model()->index(row, 4).data(wp::ui::ApprovalRole).toBool()) {
          keyboard = queue->model()->index(row, 4);
          break;
        }
      QVERIFY(keyboard.isValid());
      const auto keyboardEntry = keyboard.data(wp::ui::ObjectRole).value<QJsonObject>();
      queue->setCurrentIndex(keyboard);
      queue->setFocus();
      QTest::keyClick(queue, Qt::Key_Space);
      QTRY_VERIFY(services.media.acquisition(room, source).value(QStringLiteral("approved")).toArray()
          .contains(keyboardEntry.value(QStringLiteral("mediaId"))));
      QModelIndex enter;
      for (int row = 0; row < queue->model()->rowCount(); ++row)
        if (queue->model()->index(row, 4).data(wp::ui::ApprovalRole).toBool()) {
          enter = queue->model()->index(row, 4);
          break;
        }
      QVERIFY(enter.isValid());
      const auto enterEntry = enter.data(wp::ui::ObjectRole).value<QJsonObject>();
      queue->setCurrentIndex(enter);
      QTest::keyClick(queue, Qt::Key_Return);
      QTRY_VERIFY(services.media.acquisition(room, source).value(QStringLiteral("approved")).toArray()
          .contains(enterEntry.value(QStringLiteral("mediaId"))));
      search->setText(filter);
      page.refresh();
      QVERIFY(!queue->model()->index(0, 4).data(wp::ui::ApprovalRole).toBool());
      screenshot(page, QStringLiteral("queue-inline-download-approved"));
      tabs->setCurrentIndex(1);
      QAction *clear = page.findChild<QAction *>(QStringLiteral("QueueClear"));
      QVERIFY(clear && clear->text().contains(QStringLiteral("Watched")));
      for (auto *action : more->menu()->actions())
        if (action->text().contains(QStringLiteral("Rename")) || action->text().contains(QStringLiteral("Approve selected sources")))
          QVERIFY(!action->isVisible());
      clear->trigger();
      auto *confirmation = page.findChild<QMessageBox *>(QStringLiteral("QueueClearConfirmation"));
      QVERIFY(confirmation && confirmation->text().contains(QStringLiteral("every member")));
      QTest::mouseClick(confirmation->button(QMessageBox::Cancel), Qt::LeftButton);
      QCOMPARE(history->model()->rowCount(), 1);
      QTRY_VERIFY_WITH_TIMEOUT(!page.findChild<QMessageBox *>(QStringLiteral("QueueClearConfirmation")), 1000);
      clear->trigger();
      confirmation = page.findChild<QMessageBox *>(QStringLiteral("QueueClearConfirmation"));
      QVERIFY(confirmation);
      for (auto *choice : confirmation->buttons())
        if (confirmation->buttonRole(choice) == QMessageBox::DestructiveRole)
          QTest::mouseClick(choice, Qt::LeftButton);
      QTRY_COMPARE_WITH_TIMEOUT(history->model()->rowCount(), 0, 5000);
      QVERIFY(services.rooms.entry(room, secondId).isEmpty());
      QVERIFY(!services.rooms.entry(room, firstId).isEmpty());
      tabs->setCurrentIndex(0);
      QCOMPARE(queue->model()->rowCount(), 1);
      QVERIFY(clear->text().contains(QStringLiteral("Upcoming")));
      screenshot(page, QStringLiteral("queue-upcoming-after-watched-clear"));
      clear->trigger();
      confirmation = page.findChild<QMessageBox *>(QStringLiteral("QueueClearConfirmation"));
      QVERIFY(confirmation && confirmation->text().contains(QStringLiteral("hidden by search")));
      for (auto *choice : confirmation->buttons())
        if (confirmation->buttonRole(choice) == QMessageBox::DestructiveRole)
          QTest::mouseClick(choice, Qt::LeftButton);
      QTRY_COMPARE_WITH_TIMEOUT(queue->model()->rowCount(), 0, 5000);
      search->clear();
      QCOMPARE(queue->model()->rowCount(), 0);
      QCOMPARE(history->model()->rowCount(), 0);
      QCOMPARE(services.rooms.room(room).value(QStringLiteral("sources")).toArray().size(), 1);
      QVERIFY(QFileInfo::exists(root + QStringLiteral("/Skyline Stories/Season 1/Episode 01.mkv")));
    } catch (const std::exception &e) {
      QFAIL(e.what());
    }
  }
  void roomWizardFileChoiceNativeRenderingAndBackgroundPlayback() {
    try {
      QTemporaryDir tmp;
      QVERIFY(tmp.isValid());
      wp::test::Coordinator server;
      server.start(tmp.filePath(QStringLiteral("server.sqlite")));
      wp::AppServices services(tmp.filePath(QStringLiteral("profile")), nullptr, true, false);
      services.store.setSetting(QStringLiteral("defaultServer"), server.url());
      services.transfers.configure({{QStringLiteral("reserveMiB"), 0}});
      wp::ui::MainWindow window(services);
      window.show();
      QVERIFY(QTest::qWaitForWindowExposed(&window));
      screenshot(window, QStringLiteral("welcome"));
      auto *create = button(window, QStringLiteral("Create a room…"));
      QVERIFY(create);
      QTest::mouseClick(create, Qt::LeftButton);
      QDialog *wizard = nullptr;
      for (auto *d : window.findChildren<QDialog *>())
        if (d->isVisible() && d->windowTitle() == QStringLiteral("Create a private room"))
          wizard = d;
      QVERIFY(wizard);
      wizard->findChild<QLineEdit *>(QStringLiteral("roomName"))->setText(QStringLiteral("Friday watch"));
      wizard->findChild<QLineEdit *>(QStringLiteral("displayName"))->setText(QStringLiteral("Alex"));
      auto *buttons = wizard->findChild<QDialogButtonBox *>();
      QVERIFY(buttons);
      QTest::mouseClick(buttons->button(QDialogButtonBox::Ok), Qt::LeftButton);
      QTRY_COMPARE_WITH_TIMEOUT(services.rooms.rooms().size(), 1, 5000);
      const auto room = services.rooms.rooms().first().toObject().value(QStringLiteral("key")).toString();
      QTRY_VERIFY_WITH_TIMEOUT(services.rooms.connected(room), 5000);
      QTest::qWait(500);
      for (auto *d : window.findChildren<QDialog *>())
        if (d->isVisible())
          d->reject();
      const auto torrent = pack(tmp.filePath(QStringLiteral("pack")));
      services.media.prepare(torrent, room);
      QPointer<wp::ui::TorrentChooser> chooser;
      QTRY_VERIFY_WITH_TIMEOUT(([&] {
                                 for (auto *d : window.findChildren<wp::ui::TorrentChooser *>())
                                   if (d->isVisible()) {
                                     chooser = d;
                                     return true;
                                   }
                                 return false;
                               })(),
                               5000);
      auto *selector = chooser->findChild<wp::ui::FileSelector *>();
      QVERIFY(selector);
      QTRY_COMPARE_WITH_TIMEOUT(selector->model.selectedCount(), 12, 5000);
      screenshot(*chooser, QStringLiteral("file-selection"));
      auto *apply = chooser->findChild<QPushButton *>(QStringLiteral("ApplySelection"));
      QVERIFY(apply);
      QTest::mouseClick(apply, Qt::LeftButton);
      QTRY_VERIFY_WITH_TIMEOUT(!chooser || !chooser->isVisible(), 5000);
      QTRY_COMPARE_WITH_TIMEOUT(services.rooms.room(room).value(QStringLiteral("entries")).toArray().size(),
                                13, 5000);
      const auto transfer = services.transfers.transfers().first().id;
      window.showTransfers(transfer);
      auto *desk = window.findChild<wp::ui::TransferDesk *>();
      QVERIFY(desk);
      auto *scope = desk->findChild<QComboBox *>(QStringLiteral("ContentScope"));
      QVERIFY(scope);
      QCOMPARE(scope->currentData().toString(), room);
      auto *content = desk->findChild<wp::ui::FileSelector *>();
      QVERIFY(content);
      content->model.chooseAll(false);
      for (const auto &f : services.transfers.source(transfer)->files())
        if (f.path.contains(QStringLiteral("Season 1/")))
          content->model.setData(content->model.fileIndex(f.index), int(Qt::Checked), Qt::CheckStateRole);
      QTest::mouseClick(desk->findChild<QPushButton *>(QStringLiteral("ApplyContentSelection")),
                        Qt::LeftButton);
      QTRY_VERIFY_WITH_TIMEOUT(([&] {
                                 int selected = 0;
                                 for (auto value :
                                      services.rooms.room(room).value(QStringLiteral("entries")).toArray())
                                   if (value.toObject().value(QStringLiteral("enabled")).toBool())
                                     ++selected;
                                 return selected == 6;
                               })(),
                               5000);
      QCOMPARE(content->model.selectedCount(), 6);
      QTest::qWait(250);
      screenshot(window, QStringLiteral("transfers"));
      const auto mediaPath = tmp.filePath(QStringLiteral("evening.mp4"));
      QProcess ffmpeg;
      ffmpeg.start(QStringLiteral("ffmpeg"),
                   {QStringLiteral("-hide_banner"), QStringLiteral("-loglevel"), QStringLiteral("error"),
                    QStringLiteral("-f"), QStringLiteral("lavfi"), QStringLiteral("-i"),
                    QStringLiteral("testsrc2=size=640x360:rate=24:duration=120"), QStringLiteral("-c:v"),
                    QStringLiteral("libx264"), QStringLiteral("-preset"), QStringLiteral("ultrafast"),
                    QStringLiteral("-movflags"), QStringLiteral("+faststart"), mediaPath});
      QVERIFY(ffmpeg.waitForFinished(30000));
      QCOMPARE(ffmpeg.exitCode(), 0);
      QSignalSpy identified(&services.library, &wp::LibraryService::identified);
      services.library.identify(mediaPath);
      QTRY_COMPARE_WITH_TIMEOUT(identified.size(), 1, 5000);
      const auto file = identified.first()[1].toJsonObject();
      const auto download = services.direct.add(
          QUrl(QStringLiteral("https://example.invalid/evening.mp4")), QStringLiteral("Evening preview.mp4"),
          file.value(QStringLiteral("sha256")).toString(), file.value(QStringLiteral("size")).toInteger());
      services.media.publishDirect(download, room);
      QString episode;
      QTRY_VERIFY_WITH_TIMEOUT(
          ([&] {
            for (auto value : services.rooms.room(room).value(QStringLiteral("entries")).toArray())
              if (value.toObject().value(QStringLiteral("sha256")) == file.value(QStringLiteral("sha256"))) {
                episode = value.toObject().value(QStringLiteral("id")).toString();
                return true;
              }
            return false;
          })(),
          5000);
      window.showRoom(room);
      services.playback.choose(episode);
      QTRY_COMPARE_WITH_TIMEOUT(services.rooms.room(room)
                                    .value(QStringLiteral("playback"))
                                    .toObject()
                                    .value(QStringLiteral("entryId"))
                                    .toString(),
                                episode, 5000);
      services.playback.joinWatch();
      QTRY_VERIFY_WITH_TIMEOUT(services.player.loaded(), 12000);
      services.playback.togglePause();
      QTRY_VERIFY_WITH_TIMEOUT(services.player.position() > 1, 5000);
      QTRY_VERIFY_WITH_TIMEOUT(window.roomPage()->video()->frames() > 3, 5000);
      QImage frame;
      auto coloredFrame = [&] {
        frame = window.roomPage()->video()->grabFramebuffer();
        QSet<QRgb> colors;
        for (int y = 0; y < frame.height(); y += 16)
          for (int x = 0; x < frame.width(); x += 16)
            colors.insert(frame.pixel(x, y));
        return colors.size() > 20;
      };
      QTRY_VERIFY2_WITH_TIMEOUT(coloredFrame(), "Native renderer returned a blank/corrupted frame", 6000);
      screenshot(window, QStringLiteral("room"));
      const auto before = services.player.position();
      window.showTransfers(transfer);
      QTRY_VERIFY2_WITH_TIMEOUT(
          services.player.position() > before + .6,
          qPrintable(QString::fromUtf8(
              QJsonDocument(QJsonObject{{QStringLiteral("player"), services.playback.diagnostics()},
                                        {QStringLiteral("timeline"),
                                         services.rooms.room(room).value(QStringLiteral("playback"))}})
                  .toJson(QJsonDocument::Compact))),
          6000);
      window.showRoom(room);
      QTest::qWait(250);
      screenshot(window, QStringLiteral("room-return"));
      window.showMinimized();
      const auto minimized = services.player.position();
      QTRY_VERIFY2_WITH_TIMEOUT(
          services.player.position() > minimized + .4,
          qPrintable(QString::fromUtf8(
              QJsonDocument(services.playback.diagnostics()).toJson(QJsonDocument::Compact))),
          6000);
      window.restoreWindow();
      QVERIFY2(QTest::qWaitForWindowExposed(&window),
               qPrintable(QStringLiteral("Restore state: visible=%1 minimized=%2 state=%3 nativeVisible=%4")
                              .arg(window.isVisible())
                              .arg(window.isMinimized())
                              .arg(int(window.windowState()))
                              .arg(window.windowHandle() ? window.windowHandle()->isVisible() : false)));
      auto *search = window.roomPage()->findChild<QLineEdit *>(QStringLiteral("queueSearch"));
      QVERIFY(search);
      search->setFocus();
      QTest::keyClicks(search, QStringLiteral("Season 1"));
      QCOMPARE(search->text(), QStringLiteral("Season 1"));
      window.resize(1100, 720);
      QTest::qWait(250);
      screenshot(window, QStringLiteral("compact"));
      QVERIFY(window.width() <= 1100);
      services.playback.playLocal(file);
      QTRY_VERIFY_WITH_TIMEOUT(services.player.loaded() && services.player.position() > .3, 6000);
      const auto localPosition = services.player.position();
      services.rooms.forget(room);
      QVERIFY(services.playback.local());
      QTRY_VERIFY2_WITH_TIMEOUT(
          services.player.position() > localPosition + .3,
          qPrintable(QString::fromUtf8(
              QJsonDocument(services.playback.diagnostics()).toJson(QJsonDocument::Compact))),
          6000);
      screenshot(window, QStringLiteral("local-after-forget"));
      auto *navigation = window.findChild<QListWidget *>(QStringLiteral("Navigation"));
      QVERIFY(navigation);
      navigation->setCurrentRow(3);
      auto *storage = window.findChild<QTableWidget *>(QStringLiteral("StorageTable"));
      QVERIFY(storage);
      QTRY_VERIFY_WITH_TIMEOUT(storage->rowCount() > 0, 5000);
      screenshot(window, QStringLiteral("storage"));
      window.close();
    } catch (const std::exception &e) {
      QFAIL(e.what());
    }
  }
};
int main(int argc, char **argv) {
  QSurfaceFormat f;
  f.setVersion(3, 3);
  f.setProfile(QSurfaceFormat::CoreProfile);
  QSurfaceFormat::setDefaultFormat(f);
  QCoreApplication::setAttribute(Qt::AA_ShareOpenGLContexts);
  QApplication app(argc, argv);
  wp::configureNativeRuntime();
  wp::ui::installTheme();
  UiFlowTests tests;
  return QTest::qExec(&tests, argc, argv);
}
#include "ui_flow_tests.moc"
