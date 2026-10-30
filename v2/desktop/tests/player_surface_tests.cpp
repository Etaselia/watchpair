#include "player_surface.h"
#ifdef WATCHPAIR_PLAYER_NATIVE_FIXTURE
#include "main_window.h"
#include "native_runtime.h"
#include "theme.h"
#endif
#include <QApplication>
#include <QComboBox>
#include <QDir>
#include <QFile>
#include <QMouseEvent>
#include <QProcess>
#include <QPushButton>
#include <QSignalSpy>
#include <QSurfaceFormat>
#include <QTemporaryDir>
#include <QtTest>
#include <cmath>
namespace {
void movePointer(QWidget &widget, const QPoint &point) {
  const auto global = widget.mapToGlobal(point);
  QCursor::setPos(global);
  QMouseEvent event(QEvent::MouseMove, point, global, Qt::NoButton, Qt::NoButton, Qt::NoModifier);
  QApplication::sendEvent(&widget, &event);
}
void capture(QWidget &widget, const QString &name) {
  const auto output = qEnvironmentVariable("WATCHPAIR_UI_OUTPUT");
  if (!output.isEmpty()) {
    QDir().mkpath(output);
    widget.grab().save(QDir(output).filePath(name + QStringLiteral(".png")));
  }
}
}
class PlayerSurfaceTests final : public QObject {
  Q_OBJECT
private slots:
  void idleControlsDoNotResizeVideoAndPauseRevealsThem() {
    auto *video = new QWidget;
    wp::ui::PlayerSurface surface(video);
    auto *controls = new QPushButton(QStringLiteral("Pause"));
    surface.addControls(controls);
    surface.resize(800, 500);
    surface.show();
    QVERIFY(QTest::qWaitForWindowExposed(&surface));
    movePointer(*video, QPoint(20, 20));
    surface.setPlaybackState(true, false);
    const auto bounds = video->geometry();
    QTRY_VERIFY_WITH_TIMEOUT(!surface.controlsVisible(), 4000);
    QCOMPARE(video->geometry(), bounds);
    QCOMPARE(video->cursor().shape(), Qt::BlankCursor);
    movePointer(*video, QPoint(30, 25));
    QTRY_VERIFY(surface.controlsVisible());
    QVERIFY(video->cursor().shape() != Qt::BlankCursor);
    surface.setPlaybackState(false, false);
    QTest::qWait(2700);
    QVERIFY(surface.controlsVisible());
    QCOMPARE(video->geometry(), bounds);
  }
  void popupAndEditingKeepNativeInteractionAndPlayerGestures() {
    auto *video = new QWidget;
    wp::ui::PlayerSurface surface(video);
    auto *combo = new QComboBox;
    combo->addItems({QStringLiteral("English"), QStringLiteral("German")});
    surface.addControls(combo);
    surface.resize(800, 500);
    surface.show();
    QVERIFY(QTest::qWaitForWindowExposed(&surface));
    QSignalSpy seek(&surface, &wp::ui::PlayerSurface::seekRequested);
    QSignalSpy chapter(&surface, &wp::ui::PlayerSurface::chapterRequested);
    QSignalSpy pause(&surface, &wp::ui::PlayerSurface::pauseRequested);
    QSignalSpy fullscreen(&surface, &wp::ui::PlayerSurface::fullscreenRequested);
    QTest::keyClick(video, Qt::Key_Right);
    QCOMPARE(seek.size(), 1);
    QCOMPARE(seek.first().first().toDouble(), 10.0);
    QTest::keyClick(video, Qt::Key_Left, Qt::ControlModifier);
    QCOMPARE(chapter.size(), 1);
    QCOMPARE(chapter.first().first().toInt(), -1);
    QTest::keyClick(video, Qt::Key_Space);
    QCOMPARE(pause.size(), 1);
    QTest::mouseDClick(video, Qt::LeftButton);
    QTest::mouseRelease(video, Qt::LeftButton);
    QCOMPARE(fullscreen.size(), 1);
    combo->setFocus();
    QTest::keyClick(combo, Qt::Key_Down);
    QCOMPARE(combo->currentIndex(), 1);
    QCOMPARE(seek.size(), 1);
    surface.setPlaybackState(true, false);
    combo->showPopup();
    QTest::qWait(2700);
    QVERIFY(surface.controlsVisible());
    combo->hidePopup();
    movePointer(*video, QPoint(25, 20));
    QTRY_VERIFY_WITH_TIMEOUT(!surface.controlsVisible(), 4000);
  }
#ifdef WATCHPAIR_PLAYER_NATIVE_FIXTURE
  void nativeRendererSurvivesFullscreenPopoutAndReturnWithWorkingSeeks() {
    try {
    QTemporaryDir tmp;
    const auto chapters = tmp.filePath(QStringLiteral("chapters.txt"));
    QFile metadata(chapters);
    QVERIFY(metadata.open(QIODevice::WriteOnly));
    metadata.write(";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=8000\ntitle=Opening\n"
                   "[CHAPTER]\nTIMEBASE=1/1000\nSTART=8000\nEND=30000\ntitle=Second chapter\n");
    metadata.close();
    const auto path = tmp.filePath(QStringLiteral("player.mkv"));
    QProcess fixture;
    fixture.start(QStringLiteral("ffmpeg"),
                  {QStringLiteral("-hide_banner"), QStringLiteral("-loglevel"), QStringLiteral("error"),
                   QStringLiteral("-f"), QStringLiteral("lavfi"), QStringLiteral("-i"),
                   QStringLiteral("testsrc2=size=320x180:rate=24:duration=30"), QStringLiteral("-f"),
                   QStringLiteral("ffmetadata"), QStringLiteral("-i"), chapters,
                   QStringLiteral("-map_chapters"), QStringLiteral("1"), QStringLiteral("-c:v"),
                   QStringLiteral("libx264"), QStringLiteral("-preset"), QStringLiteral("ultrafast"), path});
    QVERIFY(fixture.waitForFinished(30000));
    QCOMPARE(fixture.exitCode(), 0);
    wp::AppServices services(tmp.filePath(QStringLiteral("profile")), nullptr, true, false);
    services.store.setSetting(QStringLiteral("closeToTray"), false);
    services.player.setVolume(0);
    wp::ui::MainWindow window(services);
    window.show();
    window.pages()->setCurrentWidget(window.roomPage());
    QSignalSpy identified(&services.library, &wp::LibraryService::identified);
    services.library.identify(path);
    QTRY_COMPARE_WITH_TIMEOUT(identified.size(), 1, 5000);
    services.playback.playLocal(identified.first()[1].toJsonObject());
    QTRY_VERIFY_WITH_TIMEOUT(services.player.loaded(), 10000);
    auto *video = window.roomPage()->video();
    auto *native = services.player.native();
    QTRY_VERIFY_WITH_TIMEOUT(video->frames() > 2, 5000);
    services.playback.togglePause();
    QTRY_VERIFY(services.player.paused());
    QTRY_COMPARE(window.roomPage()->findChild<QLabel *>(QStringLiteral("PlaybackState"))->text(),
                 QStringLiteral("Paused"));
    auto click = [&](const QString &name) {
      auto *button = window.roomPage()->playerSurface()->findChild<QPushButton *>(name);
      if (!button) return false;
      button->click();
      return true;
    };
    QTRY_VERIFY(window.roomPage()->findChild<QPushButton *>(QStringLiteral("NextChapter"))->isEnabled());
    QVERIFY(click(QStringLiteral("NextChapter")));
    QTRY_VERIFY_WITH_TIMEOUT(std::abs(services.player.position() - 8) < .3, 5000);
    QVERIFY(click(QStringLiteral("PreviousChapter")));
    QTRY_VERIFY_WITH_TIMEOUT(services.player.position() < .3, 5000);
    QVERIFY(click(QStringLiteral("SeekForward")));
    QTRY_VERIFY_WITH_TIMEOUT(std::abs(services.player.position() - 10) < .3, 5000);
    QVERIFY(click(QStringLiteral("SeekBack")));
    QTRY_VERIFY_WITH_TIMEOUT(services.player.position() < .3, 5000);
    QTRY_VERIFY(window.roomPage()->findChild<QLabel *>(QStringLiteral("PlaybackTime"))
                    ->text().startsWith(QStringLiteral("0:00 /")));
    QVERIFY(click(QStringLiteral("PlayerFullscreen")));
    QTRY_VERIFY(window.isFullScreen());
    QTRY_COMPARE(video->mapTo(&window, QPoint()), QPoint());
    QTRY_COMPARE(video->size(), window.size());
    capture(window, QStringLiteral("player-fullscreen"));
    QTest::keyClick(video, Qt::Key_Escape);
    QTRY_VERIFY(!window.isFullScreen());
    QVERIFY(click(QStringLiteral("PopoutPlayer")));
    QTRY_VERIFY(video->window() != &window);
    auto *detached = video->window();
    QCOMPARE(detached->objectName(), QStringLiteral("DetachedPlayer"));
    QCOMPARE(services.player.native(), native);
    QCOMPARE(window.roomPage()->video(), video);
    QVERIFY(video->rendering());
    services.playback.togglePause();
    const auto before = video->frames();
    QTRY_VERIFY_WITH_TIMEOUT(video->frames() > before + 3, 5000);
    QCOMPARE(video->glError(), 0);
    window.hide();
    QVERIFY(detached->isVisible());
    capture(*detached, QStringLiteral("player-popout"));
    QTest::mouseDClick(video, Qt::LeftButton);
    QTest::mouseRelease(video, Qt::LeftButton);
    QTRY_VERIFY(detached->isFullScreen());
    QTRY_COMPARE(video->size(), detached->size());
    window.restoreWindow();
    QVERIFY(!window.isFullScreen());
    QVERIFY(detached->isFullScreen());
    window.hide();
    QTest::keyClick(video, Qt::Key_Escape);
    QTRY_VERIFY(!detached->isFullScreen());
    detached->close();
    QTRY_VERIFY(window.isVisible());
    QTRY_COMPARE(video->window(), static_cast<QWidget *>(&window));
    QCOMPARE(services.player.native(), native);
    QVERIFY(video->rendering());
    const auto resumed = video->frames();
    QTRY_VERIFY_WITH_TIMEOUT(video->frames() > resumed + 3, 5000);
    QCOMPARE(video->glError(), 0);
    auto *chapterChoice = window.roomPage()->findChild<QComboBox *>(QStringLiteral("Chapters"));
    QVERIFY(chapterChoice);
    QVERIFY(chapterChoice->isEnabled());
    QCOMPARE(chapterChoice->count(), 3);
    QSignalSpy staleChapter(&services, &wp::AppServices::issue);
    // A chapter popup can still contain old choices when native loading stops.
    // Deliver that choice before the next UI refresh, as a queued activation can.
    services.player.stop();
    QVERIFY(!services.player.loaded());
    QVERIFY(QMetaObject::invokeMethod(chapterChoice, "activated", Qt::DirectConnection, Q_ARG(int, 2)));
    QCOMPARE(staleChapter.size(), 1);
    QCOMPARE(staleChapter.first()[0].toString(), QStringLiteral("PLAYBACK_CHANGED"));
    window.roomPage()->refresh();
    QVERIFY(!chapterChoice->isEnabled());
    QCOMPARE(chapterChoice->count(), 1);
    window.prepareToQuit();
    } catch (const std::exception &error) {
      QFAIL(error.what());
    }
  }
#endif
};
int main(int argc, char **argv) {
  QSurfaceFormat format;
  format.setVersion(3, 3);
  format.setProfile(QSurfaceFormat::CoreProfile);
  QSurfaceFormat::setDefaultFormat(format);
  QCoreApplication::setAttribute(Qt::AA_ShareOpenGLContexts);
  QApplication app(argc, argv);
#ifdef WATCHPAIR_PLAYER_NATIVE_FIXTURE
  wp::configureNativeRuntime();
  wp::ui::installTheme();
#endif
  PlayerSurfaceTests tests;
  return QTest::qExec(&tests, argc, argv);
}
#include "player_surface_tests.moc"
