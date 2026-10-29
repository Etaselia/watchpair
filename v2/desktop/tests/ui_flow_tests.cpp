#include "../../testing/torrent_fixture.h"
#include "coordinator_fixture.h"
#include "main_window.h"
#include "native_runtime.h"
#include "theme.h"
#include <QApplication>
#include <QDialogButtonBox>
#include <QFile>
#include <QProcess>
#include <QSurfaceFormat>
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
} // namespace
class UiFlowTests final : public QObject {
  Q_OBJECT
private slots:
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
