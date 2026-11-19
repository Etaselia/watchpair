#include "coordinator_fixture.h"
#include "main_window.h"
#include "native_runtime.h"
#include "seek_slider.h"
#include "window_geometry.h"
#include <QCryptographicHash>
#include <QDataStream>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QMouseEvent>
#include <QPushButton>
#include <QScreen>
#include <QSurfaceFormat>
#include <QTemporaryDir>
#include <QtTest>

namespace {
QJsonArray seekCommands(wp::LocalStore &store) {
  QJsonArray result;
  for (const auto value : store.all(QStringLiteral("room-command"))) {
    const auto envelope = value.toObject().value(QStringLiteral("envelope")).toObject();
    if (envelope.value(QStringLiteral("command")).toObject().value(QStringLiteral("type")) == QStringLiteral("playback.seek"))
      result.append(envelope);
  }
  return result;
}
QJsonObject localFile(const QString &path) {
  QFile file(path);
  if (!file.open(QIODevice::ReadOnly))
    throw std::runtime_error("Cannot open local media fixture");
  QCryptographicHash hash(QCryptographicHash::Sha256);
  if (!hash.addData(&file))
    throw std::runtime_error("Cannot hash local media fixture");
  const QFileInfo info(file);
  return {{QStringLiteral("path"), info.canonicalFilePath()}, {QStringLiteral("size"), info.size()},
          {QStringLiteral("mtime"), info.lastModified().toMSecsSinceEpoch()},
          {QStringLiteral("sha256"), QString::fromLatin1(hash.result().toHex())}};
}
QJsonObject wave(const QString &path, char sample) {
  QFile file(path);
  if (!file.open(QIODevice::WriteOnly))
    throw std::runtime_error("Cannot create audio fixture");
  QDataStream out(&file);
  out.setByteOrder(QDataStream::LittleEndian);
  constexpr quint32 bytes = 8000 * 2 * 30;
  out.writeRawData("RIFF", 4); out << quint32(36 + bytes);
  out.writeRawData("WAVEfmt ", 8); out << quint32(16) << quint16(1) << quint16(1)
      << quint32(8000) << quint32(16000) << quint16(2) << quint16(16);
  out.writeRawData("data", 4); out << bytes;
  file.write(QByteArray(bytes, sample));
  file.close();
  return localFile(path);
}
} // namespace
class PlayerControlFlowTests final : public QObject {
  Q_OBJECT
private slots:
  void roomSeekUsesOneFinalCommandAndRejectsChangedContext_data() {
    QTest::addColumn<int>("change");
    QTest::newRow("one-release-command") << 0;
    QTest::newRow("cancel") << 1;
    QTest::newRow("another-room-same-generation-and-media") << 2;
    QTest::newRow("another-episode") << 3;
    QTest::newRow("another-generation") << 4;
  }
  void roomSeekUsesOneFinalCommandAndRejectsChangedContext() {
    QFETCH(int, change);
    try {
      QTemporaryDir tmp;
      wp::test::Coordinator server; server.start(tmp.filePath(QStringLiteral("server.sqlite")));
      wp::AppServices app(tmp.filePath(QStringLiteral("profile")), nullptr, true, true);
      app.store.setSetting(QStringLiteral("acquisitionPolicy"), QStringLiteral("Never"));
      QStringList rooms;
      for (int roomIndex = 0; roomIndex < (change == 2 ? 2 : 1); ++roomIndex) {
        QSignalSpy entered(&app.rooms, &wp::RoomClient::entered);
        app.rooms.create(server.url(), QStringLiteral("Seek room"), QStringLiteral("Host"));
        QTRY_COMPARE_WITH_TIMEOUT(entered.size(), 1, 5000);
        const auto room = entered.first()[1].toString(); rooms.append(room);
        QTRY_VERIFY_WITH_TIMEOUT(app.rooms.connected(room), 5000);
        for (int i = 0; i < 2; ++i) {
          const QString sha(64, QChar('a' + i)), identity = QStringLiteral("sha256:") + sha;
          const QJsonObject source{{QStringLiteral("id"), identity}, {QStringLiteral("identity"), identity},
              {QStringLiteral("kind"), QStringLiteral("direct")}, {QStringLiteral("label"), QStringLiteral("Fixture")},
              {QStringLiteral("uri"), QStringLiteral("https://example.invalid/fixture.mp4")}};
          const QJsonObject file{{QStringLiteral("mediaId"), wp::RoomMedia::mediaId(identity, 0)},
              {QStringLiteral("path"), QStringLiteral("episode%1.mp4").arg(i)}, {QStringLiteral("label"), QStringLiteral("Episode")},
              {QStringLiteral("fileIndex"), 0}, {QStringLiteral("size"), 1024}, {QStringLiteral("duration"), 120},
              {QStringLiteral("sha256"), sha}, {QStringLiteral("selected"), true}};
          app.rooms.command(room, {{QStringLiteral("type"), QStringLiteral("queue.add")},
              {QStringLiteral("source"), source}, {QStringLiteral("files"), QJsonArray{file}}});
          QTRY_COMPARE_WITH_TIMEOUT(app.rooms.room(room).value(QStringLiteral("entries")).toArray().size(), i + 1, 5000);
        }
        app.rooms.command(room, {{QStringLiteral("type"), QStringLiteral("playback.choose")},
            {QStringLiteral("entryId"), app.rooms.room(room).value(QStringLiteral("entries")).toArray().first().toObject().value(QStringLiteral("id"))}});
        QTRY_COMPARE_WITH_TIMEOUT(app.rooms.room(room).value(QStringLiteral("playback")).toObject().value(QStringLiteral("generation")).toInt(), 1, 5000);
      }
      wp::ui::RoomPage page(app); page.setRoom(rooms.first());
      auto *slider = page.findChild<wp::ui::SeekSlider *>(QStringLiteral("SeekSlider"));
      QVERIFY(slider); slider->resize(400, 30); QVERIFY(slider->isEnabled());
      QJsonArray released;
      connect(slider, &QSlider::sliderReleased, &page, [&] { released = seekCommands(app.store); });
      QTest::mousePress(slider, Qt::LeftButton, Qt::NoModifier, QPoint(140, 15));
      QTest::mouseMove(slider, QPoint(220, 15));
      QTest::mouseMove(slider, QPoint(280, 15));
      QVERIFY(seekCommands(app.store).isEmpty());
      if (change == 1)
        QTest::keyClick(slider, Qt::Key_Escape);
      else if (change == 2) {
        const auto first = app.rooms.room(rooms[0]).value(QStringLiteral("playback")).toObject();
        const auto other = app.rooms.room(rooms[1]).value(QStringLiteral("playback")).toObject();
        QCOMPARE(first.value(QStringLiteral("generation")), other.value(QStringLiteral("generation")));
        QCOMPARE(first.value(QStringLiteral("entryId")), other.value(QStringLiteral("entryId")));
        page.setRoom(rooms[1]);
      } else if (change == 3 || change == 4) {
        const auto command = change == 3
            ? QJsonObject{{QStringLiteral("type"), QStringLiteral("playback.choose")},
                {QStringLiteral("entryId"), app.rooms.room(rooms.first()).value(QStringLiteral("entries")).toArray().last().toObject().value(QStringLiteral("id"))}}
            : QJsonObject{{QStringLiteral("type"), QStringLiteral("playback.pause")}};
        app.rooms.command(rooms.first(), command);
        QTRY_COMPARE_WITH_TIMEOUT(app.rooms.room(rooms.first()).value(QStringLiteral("playback")).toObject().value(QStringLiteral("generation")).toInt(), 2, 5000);
      }
      QTest::mouseRelease(slider, Qt::LeftButton, Qt::NoModifier, QPoint(340, 15));
      QCOMPARE(released.size(), change == 0 ? 1 : 0);
      if (change == 0) {
        const auto envelope = released.first().toObject();
        QCOMPARE(envelope.value(QStringLiteral("generation")).toInt(), 1);
        QVERIFY(envelope.value(QStringLiteral("command")).toObject().value(QStringLiteral("position")).toDouble() > 90);
      }
      app.shutdown();
    } catch (const std::exception &error) { QFAIL(error.what()); }
  }
  void localScrubPreviewsUntilReleaseAndCannotSeekTheNextFile() {
    try {
      QTemporaryDir tmp;
      const auto first = wave(tmp.filePath(QStringLiteral("first.wav")), 0);
      const auto next = wave(tmp.filePath(QStringLiteral("next.wav")), 1);
      wp::AppServices app(tmp.filePath(QStringLiteral("profile")), nullptr, true, true);
      wp::ui::RoomPage page(app);
      app.playback.playLocal(first);
      QTRY_VERIFY_WITH_TIMEOUT(app.player.loaded() && app.player.duration() > 29, 5000);
      app.playback.togglePause(); QTRY_VERIFY(app.player.paused()); page.refresh();
      auto *slider = page.findChild<wp::ui::SeekSlider *>(QStringLiteral("SeekSlider"));
      QVERIFY(slider); slider->resize(400, 30);
      QTest::mousePress(slider, Qt::LeftButton, Qt::NoModifier, QPoint(200, 15));
      QTest::mouseMove(slider, QPoint(300, 15));
      QVERIFY(app.player.sampledPosition() < 2);
      QTest::mouseRelease(slider, Qt::LeftButton, Qt::NoModifier, QPoint(300, 15));
      QTRY_VERIFY_WITH_TIMEOUT(app.player.sampledPosition() > 20, 5000);
      QTest::mousePress(slider, Qt::LeftButton, Qt::NoModifier, QPoint(300, 15));
      app.playback.playLocal(next);
      QTRY_VERIFY_WITH_TIMEOUT(app.player.loaded() && app.player.duration() > 29, 5000);
      app.playback.togglePause(); QTRY_VERIFY(app.player.paused());
      QTest::mouseRelease(slider, Qt::LeftButton, Qt::NoModifier, QPoint(300, 15));
      QTest::qWait(200);
      QVERIFY(app.player.sampledPosition() < 2);
      app.shutdown();
    } catch (const std::exception &error) { QFAIL(error.what()); }
  }
  void chapterThumbnailFollowsThePlayerWithoutSeeking() {
    const auto fixtures = qEnvironmentVariable("WATCHPAIR_MEDIA_FIXTURES");
    const auto path = QDir(fixtures).filePath(QStringLiteral("tracks.mkv"));
    if (fixtures.isEmpty() || !QFileInfo::exists(path))
      QSKIP("Set WATCHPAIR_MEDIA_FIXTURES to the generated chapter and track fixtures.");
    try {
      QTemporaryDir tmp;
      wp::AppServices app(tmp.filePath(QStringLiteral("profile")), nullptr, true, true);
      wp::ui::MainWindow window(app);
      window.resize(1100, 750);
      window.show();
      window.pages()->setCurrentWidget(window.roomPage());
      const auto file = localFile(path);
      const auto identity = QStringLiteral("sha256:") + file.value(QStringLiteral("sha256")).toString();
      app.store.put(QStringLiteral("resume"), identity, {{QStringLiteral("position"), 1.0}});
      app.playback.playLocal(file);
      QTRY_VERIFY_WITH_TIMEOUT(app.player.loaded() && app.player.chapters().size() == 2 &&
                                   !app.playback.thumbnailFile().isEmpty(),
                               10000);
      if (!app.playback.paused())
        app.playback.togglePause();
      QTRY_VERIFY(app.player.paused());
      QTRY_VERIFY_WITH_TIMEOUT(!app.player.seeking() && qAbs(app.player.sampledPosition() - 1.0) < .12, 5000);
      window.roomPage()->refresh();
      auto *surface = window.roomPage()->playerSurface();
      auto *slider = surface->findChild<wp::ui::SeekSlider *>(QStringLiteral("SeekSlider"));
      auto *preview = surface->findChild<QWidget *>(QStringLiteral("SeekPreview"));
      auto *frame = surface->findChild<QLabel *>(QStringLiteral("SeekThumbnail"));
      auto *chapter = surface->findChild<QLabel *>(QStringLiteral("SeekPreviewChapter"));
      auto *more = window.roomPage()->findChild<QPushButton *>(QStringLiteral("PopoutPlayer"));
      QVERIFY(slider && preview && frame && chapter && more);
      const auto unchanged = app.player.sampledPosition();
      const auto move = [](QWidget *widget, const QPoint &at) {
        QMouseEvent event(QEvent::MouseMove, at, widget->mapToGlobal(at), Qt::NoButton, Qt::NoButton, Qt::NoModifier);
        QApplication::sendEvent(widget, &event);
      };
      const auto hover = [&] {
        move(surface, QPoint(surface->width() / 2, surface->height() - 4));
        move(slider, QPoint(slider->width() * 4 / 5, slider->height() / 2));
      };
      const auto ready = [&] { return preview->isVisible() && frame->isVisible() && !frame->pixmap().isNull(); };
      const auto details = [&] {
        return tr("Surface %1 · timeline %2 · preview %3 · chapter %4")
            .arg(surface->isVisible()).arg(slider->isVisible()).arg(preview->isVisible()).arg(chapter->text());
      };
      hover();
      QTRY_VERIFY2_WITH_TIMEOUT(ready(), qPrintable(details()), 5000);
      QCOMPARE(chapter->text(), QStringLiteral("Episode"));
      const auto image = frame->pixmap().toImage();
      QVERIFY(image.pixel(10, 10) != image.pixel(image.width() - 10, 10));
      QCOMPARE(app.player.sampledPosition(), unchanged);
      QVERIFY(seekCommands(app.store).isEmpty());
      QVERIFY(preview->geometry().bottom() < slider->mapTo(surface, QPoint()).y());

      more->click();
      QVERIFY(surface->window() != &window);
      QTRY_VERIFY_WITH_TIMEOUT(surface->isVisible(), 5000);
      hover();
      QTRY_VERIFY2_WITH_TIMEOUT(ready(), qPrintable(details()), 5000);
      QCOMPARE(app.player.sampledPosition(), unchanged);
      QVERIFY(seekCommands(app.store).isEmpty());
      surface->fullscreenRequested();
      QTRY_VERIFY(surface->window()->isFullScreen());
      hover();
      QTRY_VERIFY2_WITH_TIMEOUT(ready(), qPrintable(details()), 5000);
      QVERIFY(preview->geometry().bottom() < slider->mapTo(surface, QPoint()).y());
      window.prepareToQuit();
      app.shutdown();
    } catch (const std::exception &error) { QFAIL(error.what()); }
  }
  void popoutNormalGeometrySurvivesReturnFullscreenAndRestart() {
    try {
      QTemporaryDir tmp;
      QRect expected;
      const auto profile = tmp.filePath(QStringLiteral("profile"));
      for (int run = 0; run < 2; ++run) {
        wp::AppServices app(profile, nullptr, true, false);
        app.store.setSetting(QStringLiteral("closeToTray"), false);
        {
          wp::ui::MainWindow window(app); window.show();
          window.pages()->setCurrentWidget(window.roomPage());
          auto *button = window.roomPage()->findChild<QPushButton *>(QStringLiteral("PopoutPlayer"));
          QVERIFY(button); button->click();
          auto *detached = window.roomPage()->playerSurface()->window();
          QVERIFY(detached != &window); QVERIFY(QTest::qWaitForWindowExposed(detached));
          if (run == 0) {
            const auto area = detached->screen()->availableGeometry();
            detached->setGeometry(QRect(area.topLeft() + QPoint(90, 70), QSize(720, 430).boundedTo(area.size())));
            QCoreApplication::processEvents(); expected = detached->geometry();
            detached->close(); QCoreApplication::processEvents();
            QCOMPARE(wp::ui::windowGeometryRect(app.store.setting(QStringLiteral("playerWindowGeometry"))), expected);
            button->click(); detached = window.roomPage()->playerSurface()->window();
            QVERIFY(QTest::qWaitForWindowExposed(detached));
          }
          QCOMPARE(detached->size(), expected.size());
          if (!QApplication::platformName().startsWith(QStringLiteral("wayland")))
            QCOMPARE(detached->geometry(), expected);
          window.roomPage()->playerSurface()->fullscreenRequested();
          QTRY_VERIFY(detached->isFullScreen());
          window.prepareToQuit();
          QCOMPARE(wp::ui::windowGeometryRect(app.store.setting(QStringLiteral("playerWindowGeometry"))), expected);
        }
        app.shutdown();
      }
    } catch (const std::exception &error) { QFAIL(error.what()); }
  }
};
int main(int argc, char **argv) {
  QSurfaceFormat format;
  format.setVersion(3, 3);
  format.setProfile(QSurfaceFormat::CoreProfile);
  QSurfaceFormat::setDefaultFormat(format);
  QCoreApplication::setAttribute(Qt::AA_ShareOpenGLContexts);
  QApplication app(argc, argv);
  wp::configureNativeRuntime();
  PlayerControlFlowTests tests;
  return QTest::qExec(&tests, argc, argv);
}
#include "player_control_flow_tests.moc"
