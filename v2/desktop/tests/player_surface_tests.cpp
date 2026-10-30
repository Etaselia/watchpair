#include "player_surface.h"
#ifdef WATCHPAIR_PLAYER_NATIVE_FIXTURE
#include "main_window.h"
#include "native_runtime.h"
#include "theme.h"
#endif
#include <QApplication>
#include <QAbstractItemView>
#include <QComboBox>
#include <QDir>
#include <QFile>
#include <QMouseEvent>
#include <QProcess>
#include <QPushButton>
#include <QSignalSpy>
#include <QScreen>
#include <QSurfaceFormat>
#include <QTemporaryDir>
#include <QVBoxLayout>
#include <QWindow>
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
bool compositorInput(const QStringList &arguments) {
  QProcess input;
  input.start(QStringLiteral("python3"),
              QStringList{qEnvironmentVariable("WATCHPAIR_WAYLAND_POPUP_INPUT")} + arguments);
  // Keep Wayland configure/paint/input delivery running while the helper
  // waits for the compositor's committed surface and generates native input.
  if (!QTest::qWaitFor([&] { return input.state() == QProcess::NotRunning; }, 5000)) {
    input.kill();
    input.waitForFinished(1000);
    return false;
  }
  qInfo().noquote() << input.readAllStandardOutput();
  if (input.exitCode() != 0)
    qWarning().noquote() << input.readAllStandardError();
  return input.exitStatus() == QProcess::NormalExit && input.exitCode() == 0;
}
bool clickPopupWidget(QWidget &widget, const QPoint &point) {
  if (!qEnvironmentVariableIsEmpty("WATCHPAIR_WAYLAND_POPUP_INPUT")) {
    const auto local = widget.mapTo(widget.window(), point);
    QStringList arguments{QStringLiteral("click"), QString::number(QCoreApplication::applicationPid()),
        widget.window()->windowType() == Qt::Popup ? QStringLiteral("popup") : QStringLiteral("toplevel"),
        QString::number(local.x()), QString::number(local.y())};
    auto *control = widget.window()->parentWidget();
    if (widget.window()->windowType() == Qt::Popup && control && control->window()->isFullScreen())
      arguments.append(QString::number(control->mapTo(control->window(), QPoint()).y()));
    else if (widget.window()->windowType() != Qt::Popup)
      arguments.append({QString::number(widget.window()->width()), QString::number(widget.window()->height())});
    return compositorInput(arguments);
  }
  QTest::mouseClick(&widget, Qt::LeftButton, Qt::NoModifier, point);
  return true;
}
class PopupClickProbe final : public QObject {
public:
  PopupClickProbe(QAbstractItemView &view, int row) : view_(view), row_(row) {
    view_.viewport()->installEventFilter(this);
  }
  bool hit = false;
protected:
  bool eventFilter(QObject *, QEvent *event) override {
    if (event->type() == QEvent::MouseButtonPress) {
      const auto *mouse = static_cast<QMouseEvent *>(event);
      hit = mouse->button() == Qt::LeftButton && view_.indexAt(mouse->position().toPoint()).row() == row_;
    }
    return false;
  }
private:
  QAbstractItemView &view_;
  int row_;
};
bool choosePopup(wp::ui::PlayerSurface &surface, QComboBox &combo, QWidget &host, int row,
                 const QString &name, bool waitIdle = false) {
  if (!qEnvironmentVariableIsEmpty("WATCHPAIR_WAYLAND_POPUP_INPUT") && host.isFullScreen() &&
      !QTest::qWaitFor([&] { return host.size() == host.screen()->geometry().size(); }, 3000))
    return false;
  surface.revealControls();
  if (!clickPopupWidget(combo, QPoint(combo.width() - 10, combo.height() / 2)))
    return false;
  if (!QTest::qWaitFor([&] { return combo.view()->isVisible(); }, 3000))
    return false;
  if (!QTest::qWaitForWindowExposed(combo.view()->window()))
    return false;
  QTest::qWait(QApplication::doubleClickInterval() + 50);
  if (waitIdle)
    QTest::qWait(2700);
  auto *popup = combo.view()->window();
  if (!surface.controlsVisible() || !combo.view()->isVisible() ||
      !popup->windowHandle() || !popup->windowHandle()->isExposed())
    return false;
  const auto index = combo.model()->index(row, 0);
  const auto point = combo.view()->visualRect(index).center();
  if (!combo.view()->viewport()->rect().contains(point))
    return false;
  if (qEnvironmentVariableIsEmpty("WATCHPAIR_WAYLAND_POPUP_INPUT")) {
    const auto global = combo.view()->viewport()->mapToGlobal(point);
    // Moving from the arrow into the list releases Qt's opening-click guard.
    QTest::mouseMove(combo.view()->viewport(), point);
    QTest::qWait(150);
    auto *hit = QApplication::widgetAt(global);
    if (!hit || (hit != combo.view()->viewport() && !combo.view()->isAncestorOf(hit)))
      return false;
  }
  capture(*popup, name + QStringLiteral("-popup"));
  const auto output = qEnvironmentVariable("WATCHPAIR_UI_OUTPUT");
  if (!output.isEmpty()) {
    const auto bounds = QRect(host.mapToGlobal(QPoint()), host.size()).united(popup->frameGeometry());
    const auto screen = host.screen()->grabWindow(0, bounds.x(), bounds.y(), bounds.width(), bounds.height());
    if (!screen.isNull())
      screen.save(QDir(output).filePath(name + QStringLiteral("-screen.png")));
    else if (!qEnvironmentVariableIsEmpty("WATCHPAIR_WAYLAND_POPUP_INPUT") &&
             !compositorInput({QStringLiteral("capture"), QDir(output).filePath(name + QStringLiteral("-screen.png"))}))
      return false;
  }
  qInfo() << name << "popup exposed" << popup->windowHandle()->isExposed()
          << "transient parent matches" << (popup->windowHandle()->transientParent() == host.windowHandle());
  if (popup->windowHandle()->transientParent() != host.windowHandle())
    return false;
  // Wayland has no global widgetAt/warp API. Probe the actual native click's
  // receiver and row instead, including compositor-constrained popup placement.
  PopupClickProbe clicked(*combo.view(), row);
  QSignalSpy activated(&combo, qOverload<int>(&QComboBox::activated));
  if (!clickPopupWidget(*combo.view()->viewport(), point))
    return false;
  const bool selected = QTest::qWaitFor([&] {
    return clicked.hit && activated.size() == 1 && activated.first().first().toInt() == row &&
           combo.currentIndex() == row && !combo.view()->isVisible();
  });
  qInfo() << name << "selected" << combo.currentIndex() << "expected" << row
          << "clicked row hit" << clicked.hit << "popup visible" << combo.view()->isVisible();
  return selected;
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
  void clickedPopupFollowsDetachedFullscreenAndReturnedSurface() {
    QWidget room, detached;
    auto *roomLayout = new QVBoxLayout(&room);
    auto *detachedLayout = new QVBoxLayout(&detached);
    auto *surface = new wp::ui::PlayerSurface(new QWidget);
    auto *combo = new QComboBox;
    combo->setObjectName(QStringLiteral("PopupRegressionSubtitles"));
    combo->addItems({QStringLiteral("Subtitles off"), QStringLiteral("English subtitles"),
                     QStringLiteral("German subtitles")});
    surface->addControls(combo);
    roomLayout->addWidget(surface);
    room.resize(900, 600);
    detached.resize(800, 500);
    room.show();
    QVERIFY(QTest::qWaitForWindowExposed(&room));
    // RoomPage inspects view visibility before the presentation host moves.
    QVERIFY(!combo->view()->isVisible());
    surface->setPlaybackState(true, false);
    QVERIFY2(choosePopup(*surface, *combo, room, 1, QStringLiteral("room-subtitle-choice"), false), "Room dropdown is visible and hit-testable");
    detachedLayout->addWidget(surface);
    room.hide();
    detached.show();
    surface->show();
    QVERIFY(QTest::qWaitForWindowExposed(&detached));
    QVERIFY2(choosePopup(*surface, *combo, detached, 2, QStringLiteral("popout-subtitle-choice"), true), "Detached dropdown is visible above the player and accepts a clicked option");
    detached.showFullScreen();
    QVERIFY(QTest::qWaitForWindowExposed(&detached));
    QVERIFY2(choosePopup(*surface, *combo, detached, 1, QStringLiteral("fullscreen-subtitle-choice"), false), "Fullscreen dropdown remains visible and interactive");
    detached.showNormal();
    roomLayout->addWidget(surface);
    detached.hide();
    room.show();
    surface->show();
    QVERIFY(QTest::qWaitForWindowExposed(&room));
    QVERIFY2(choosePopup(*surface, *combo, room, 2, QStringLiteral("returned-subtitle-choice"), false), "Returned dropdown retains its native popup interaction");
  }
  void freshlyCreatedFullscreenPopupRemainsVisibleAndInteractive() {
    QWidget host;
    auto *layout = new QVBoxLayout(&host);
    host.resize(800, 500);
    host.showFullScreen();
    QVERIFY(QTest::qWaitForWindowExposed(&host));
    if (!qEnvironmentVariableIsEmpty("WATCHPAIR_WAYLAND_POPUP_INPUT"))
      QTRY_COMPARE(host.size(), host.screen()->geometry().size());
    auto *surface = new wp::ui::PlayerSurface(new QWidget);
    auto *combo = new QComboBox;
    combo->addItems({QStringLiteral("Subtitles off"), QStringLiteral("English subtitles"),
                     QStringLiteral("German subtitles")});
    surface->addControls(combo);
    layout->addWidget(surface);
    surface->show();
    layout->activate();
    surface->setPlaybackState(true, false);
    QVERIFY2(choosePopup(*surface, *combo, host, 2, QStringLiteral("fresh-fullscreen-subtitles")),
             "A fresh fullscreen popup has no prior native owner or window coordinates");
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
    const auto subtitlePath = tmp.filePath(QStringLiteral("subtitles.srt"));
    QFile subtitleFile(subtitlePath);
    QVERIFY(subtitleFile.open(QIODevice::WriteOnly));
    subtitleFile.write("1\n00:00:00,000 --> 00:00:29,000\nPopup visibility regression subtitle\n");
    subtitleFile.close();
    const auto path = tmp.filePath(QStringLiteral("player.mkv"));
    QProcess fixture;
    fixture.start(QStringLiteral("ffmpeg"),
                  {QStringLiteral("-hide_banner"), QStringLiteral("-loglevel"), QStringLiteral("error"),
                   QStringLiteral("-f"), QStringLiteral("lavfi"), QStringLiteral("-i"),
                   QStringLiteral("testsrc2=size=320x180:rate=24:duration=30"), QStringLiteral("-f"),
                   QStringLiteral("ffmetadata"), QStringLiteral("-i"), chapters,
                   QStringLiteral("-f"), QStringLiteral("srt"), QStringLiteral("-i"), subtitlePath,
                   QStringLiteral("-map"), QStringLiteral("0:v"), QStringLiteral("-map"), QStringLiteral("2:s"),
                   QStringLiteral("-map_chapters"), QStringLiteral("1"), QStringLiteral("-c:v"),
                   QStringLiteral("libx264"), QStringLiteral("-preset"), QStringLiteral("ultrafast"),
                   QStringLiteral("-c:s"), QStringLiteral("ass"), QStringLiteral("-metadata:s:s:0"),
                   QStringLiteral("title=English popup subtitles"), path});
    QVERIFY(fixture.waitForFinished(30000));
    QCOMPARE(fixture.exitCode(), 0);
    const auto nextPath = tmp.filePath(QStringLiteral("next-without-subtitles.mkv"));
    fixture.start(QStringLiteral("ffmpeg"),
                  {QStringLiteral("-hide_banner"), QStringLiteral("-loglevel"), QStringLiteral("error"),
                   QStringLiteral("-i"), path, QStringLiteral("-map"), QStringLiteral("0:v"),
                   QStringLiteral("-map_chapters"), QStringLiteral("0"), QStringLiteral("-c"),
                   QStringLiteral("copy"), nextPath});
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
    const auto initialFile = identified.first()[1].toJsonObject();
    services.library.identify(nextPath);
    QTRY_COMPARE_WITH_TIMEOUT(identified.size(), 2, 5000);
    const auto nextFile = identified.last()[1].toJsonObject();
    QVERIFY(initialFile.value(QStringLiteral("sha256")) != nextFile.value(QStringLiteral("sha256")));
    services.playback.playLocal(initialFile);
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
    auto *surface = window.roomPage()->playerSurface();
    auto *subtitleChoice = surface->findChild<QComboBox *>(QStringLiteral("SharedSubtitles"));
    QVERIFY(subtitleChoice);
    QTRY_VERIFY(subtitleChoice->count() > 1);
    const auto subtitleId = subtitleChoice->itemData(1).toString();
    QVERIFY2(choosePopup(*surface, *subtitleChoice, *detached, 1,
                         QStringLiteral("native-popout-subtitles"), true),
             "Real renderer pop-out dropdown paints above video and accepts a clicked subtitle");
    QTRY_COMPARE(services.playback.subtitleChoice(), subtitleId);
    QTest::mouseDClick(video, Qt::LeftButton);
    QTest::mouseRelease(video, Qt::LeftButton);
    QTRY_VERIFY(detached->isFullScreen());
    QTRY_COMPARE(video->size(), detached->size());
    QVERIFY2(choosePopup(*surface, *subtitleChoice, *detached, 0,
                         QStringLiteral("native-fullscreen-subtitles")),
             "Real renderer fullscreen dropdown remains visible and hit-testable");
    QTRY_COMPARE(services.playback.subtitleChoice(), QStringLiteral("off"));
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
    QVERIFY2(choosePopup(*surface, *subtitleChoice, window, 1,
                         QStringLiteral("native-returned-subtitles")),
             "Returned renderer dropdown keeps its current native owner and clicked selection");
    QTRY_COMPARE(services.playback.subtitleChoice(), subtitleId);
    const auto firstEntry = services.playback.entryId();
    QVERIFY(clickPopupWidget(*subtitleChoice, QPoint(subtitleChoice->width() - 10, subtitleChoice->height() / 2)));
    QTRY_VERIFY(subtitleChoice->view()->isVisible());
    QVERIFY(QTest::qWaitForWindowExposed(subtitleChoice->view()->window()));
    QVERIFY(subtitleChoice->count() > 1);
    services.playback.playLocal(nextFile);
    QVERIFY(services.playback.entryId() != firstEntry);
    QVERIFY(!services.player.tracksKnown());
    window.roomPage()->refresh();
    QVERIFY(!subtitleChoice->view()->isVisible());
    QVERIFY(!subtitleChoice->isEnabled());
    capture(window, QStringLiteral("native-preview-changing-tracks"));
    QTRY_VERIFY_WITH_TIMEOUT(services.player.loaded() && services.player.tracksKnown(), 10000);
    window.roomPage()->refresh();
    QTRY_VERIFY(subtitleChoice->isEnabled());
    QCOMPARE(subtitleChoice->count(), 1);
    QCOMPARE(subtitleChoice->currentData().toString(), QStringLiteral("off"));
    QCOMPARE(subtitleChoice->findData(subtitleId), -1);
    QCOMPARE(services.playback.subtitleChoice(), QStringLiteral("off"));
    QCOMPARE(services.player.native(), native);
    QVERIFY2(choosePopup(*surface, *subtitleChoice, window, 0,
                         QStringLiteral("native-new-preview-subtitles")),
             "The next video's popup contains only its own ready subtitle choices");
    auto *chapterChoice = window.roomPage()->findChild<QComboBox *>(QStringLiteral("Chapters"));
    QVERIFY(chapterChoice);
    QTRY_VERIFY(chapterChoice->isEnabled());
    QTRY_COMPARE(chapterChoice->count(), 3);
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
