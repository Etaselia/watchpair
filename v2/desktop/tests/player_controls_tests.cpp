#include "seek_slider.h"
#include "window_geometry.h"
#include <QApplication>
#include <QProxyStyle>
#include <QSignalSpy>
#include <QStyleFactory>
#include <QStyleOptionSlider>
#include <QtTest>

namespace {
class OffsetSliderStyle final : public QProxyStyle {
public:
  OffsetSliderStyle() : QProxyStyle(QStyleFactory::create(QStringLiteral("Fusion"))) {}
  QRect subControlRect(ComplexControl control, const QStyleOptionComplex *option,
                       SubControl sub, const QWidget *widget) const override {
    if (control == CC_Slider) {
      if (sub == SC_SliderGroove)
        return {30, 14, 300, 6};
      if (sub == SC_SliderHandle) {
        const auto *slider = qstyleoption_cast<const QStyleOptionSlider *>(option);
        return {30 + QStyle::sliderPositionFromValue(slider->minimum, slider->maximum,
                    slider->sliderPosition, 280, slider->upsideDown), 7, 20, 20};
      }
    }
    return QProxyStyle::subControlRect(control, option, sub, widget);
  }
};
void prepare(wp::ui::SeekSlider &slider, QStyle &style) {
  slider.setStyle(&style);
  slider.setRange(0, 1000);
  slider.resize(360, 36);
  slider.show();
  QCoreApplication::processEvents();
}
} // namespace

class PlayerControlsTests final : public QObject {
  Q_OBJECT
private slots:
  void groovePressTracksAbsolutelyAndReleaseCommitsOnce() {
    OffsetSliderStyle style;
    wp::ui::SeekSlider slider(Qt::Horizontal);
    prepare(slider, style);
    slider.setValue(100);
    QSignalSpy pressed(&slider, &QSlider::sliderPressed), moved(&slider, &QSlider::sliderMoved),
               released(&slider, &QSlider::sliderReleased);
    int beforePress = -1, committed = -1;
    connect(&slider, &QSlider::sliderPressed, this, [&] { beforePress = slider.value(); });
    connect(&slider, &QSlider::sliderReleased, this, [&] { committed = slider.value(); });
    QTest::mousePress(&slider, Qt::LeftButton, Qt::NoModifier, QPoint(180, 17));
    QCOMPARE(beforePress, 100);
    QCOMPARE(slider.value(), 500);
    QVERIFY(slider.isSliderDown());
    QCOMPARE(pressed.size(), 1);
    QCOMPARE(released.size(), 0);
    QTest::mouseMove(&slider, QPoint(250, 17));
    QCOMPARE(slider.value(), 750);
    QCOMPARE(released.size(), 0);
    QVERIFY(moved.size() >= 2);
    QTest::mouseRelease(&slider, Qt::LeftButton, Qt::NoModifier, QPoint(320, 17));
    QCOMPARE(released.size(), 1);
    QCOMPARE(committed, 1000);
    QVERIFY(!slider.isSliderDown());
  }
  void styleMappingRespectsDirectionAndInversion_data() {
    QTest::addColumn<bool>("rtl");
    QTest::addColumn<bool>("inverted");
    QTest::addColumn<int>("left");
    QTest::newRow("ltr") << false << false << 0;
    QTest::newRow("rtl") << true << false << 1000;
    QTest::newRow("ltr-inverted") << false << true << 1000;
    QTest::newRow("rtl-inverted") << true << true << 0;
  }
  void styleMappingRespectsDirectionAndInversion() {
    QFETCH(bool, rtl);
    QFETCH(bool, inverted);
    QFETCH(int, left);
    OffsetSliderStyle style;
    wp::ui::SeekSlider slider(Qt::Horizontal);
    prepare(slider, style);
    slider.setLayoutDirection(rtl ? Qt::RightToLeft : Qt::LeftToRight);
    slider.setInvertedAppearance(inverted);
    QTest::mouseClick(&slider, Qt::LeftButton, Qt::NoModifier, QPoint(40, 17));
    QCOMPARE(slider.value(), left);
    QTest::mouseClick(&slider, Qt::LeftButton, Qt::NoModifier, QPoint(320, 17));
    QCOMPARE(slider.value(), 1000 - left);
  }
  void handleIsAnIndicatorAndOutsideDragClamps() {
    OffsetSliderStyle style;
    wp::ui::SeekSlider slider(Qt::Horizontal);
    prepare(slider, style);
    slider.setValue(500);
    // Even a handle-edge press maps to its absolute point rather than retaining
    // an offset between the pointer and the old handle center.
    QTest::mousePress(&slider, Qt::LeftButton, Qt::NoModifier, QPoint(171, 17));
    QVERIFY(slider.value() < 500);
    QTest::mouseMove(&slider, QPoint(-30, 17));
    QCOMPARE(slider.value(), 0);
    QTest::mouseRelease(&slider, Qt::LeftButton, Qt::NoModifier, QPoint(500, 17));
    QCOMPARE(slider.value(), 1000);
  }
  void releaseValueIsFinalWithTrackingDisabled() {
    OffsetSliderStyle style;
    wp::ui::SeekSlider slider(Qt::Horizontal);
    prepare(slider, style);
    slider.setTracking(false);
    slider.setValue(100);
    int committed = -1;
    connect(&slider, &QSlider::sliderReleased, this, [&] { committed = slider.value(); });
    QTest::mousePress(&slider, Qt::LeftButton, Qt::NoModifier, QPoint(180, 17));
    QCOMPARE(slider.sliderPosition(), 500);
    QCOMPARE(slider.value(), 100);
    QTest::mouseRelease(&slider, Qt::LeftButton, Qt::NoModifier, QPoint(250, 17));
    QCOMPARE(committed, 750);
  }
  void cancelledGestureCannotCommit_data() {
    QTest::addColumn<int>("reason");
    QTest::newRow("escape") << 0;
    QTest::newRow("disabled") << 1;
    QTest::newRow("hidden") << 2;
    QTest::newRow("mouse-grab-lost") << 3;
  }
  void cancelledGestureCannotCommit() {
    QFETCH(int, reason);
    OffsetSliderStyle style;
    wp::ui::SeekSlider slider(Qt::Horizontal);
    prepare(slider, style);
    slider.setValue(100);
    bool cancelled = false;
    int commits = 0;
    connect(&slider, &wp::ui::SeekSlider::scrubCancelled, this, [&] { cancelled = true; });
    connect(&slider, &QSlider::sliderReleased, this, [&] { if (!cancelled) ++commits; });
    QTest::mousePress(&slider, Qt::LeftButton, Qt::NoModifier, QPoint(250, 17));
    if (reason == 0)
      QTest::keyClick(&slider, Qt::Key_Escape);
    else if (reason == 1)
      slider.setEnabled(false);
    else if (reason == 2)
      slider.hide();
    else {
      QEvent ungrab(QEvent::UngrabMouse);
      QApplication::sendEvent(&slider, &ungrab);
    }
    QTest::mouseRelease(&slider, Qt::LeftButton, Qt::NoModifier, QPoint(250, 17));
    QVERIFY(cancelled);
    QCOMPARE(commits, 0);
    QVERIFY(!slider.isSliderDown());
    QCOMPARE(slider.value(), 100);
  }
  void nativeKeyboardAndOtherMouseButtonsRemainSensible() {
    OffsetSliderStyle style;
    wp::ui::SeekSlider slider(Qt::Horizontal);
    prepare(slider, style);
    slider.setValue(500);
    slider.setSingleStep(10);
    slider.setPageStep(100);
    QSignalSpy pressed(&slider, &QSlider::sliderPressed), released(&slider, &QSlider::sliderReleased);
    QTest::mouseClick(&slider, Qt::RightButton, Qt::NoModifier, QPoint(40, 17));
    QCOMPARE(slider.value(), 500);
    QTest::keyClick(&slider, Qt::Key_Right);
    QCOMPARE(slider.value(), 510);
    QTest::keyClick(&slider, Qt::Key_PageUp);
    QCOMPARE(slider.value(), 610);
    QTest::keyClick(&slider, Qt::Key_Home);
    QCOMPARE(slider.value(), 0);
    QTest::keyClick(&slider, Qt::Key_End);
    QCOMPARE(slider.value(), 1000);
    QCOMPARE(pressed.size(), 0);
    QCOMPARE(released.size(), 0);
  }
  void savedGeometryFitsRemovedAndNegativeCoordinateMonitors() {
    const QRect left(-1920, 0, 1920, 1080), primary(0, 0, 1366, 728);
    const QRect saved(-1700, 80, 800, 600);
    QCOMPARE(wp::ui::fitWindowGeometry(saved, {left, primary}, primary), saved);
    const auto moved = wp::ui::fitWindowGeometry(saved, {primary}, primary);
    QVERIFY(primary.contains(moved));
    QCOMPARE(moved.size(), saved.size());
    const auto huge = wp::ui::fitWindowGeometry(QRect(8000, -400, 3000, 1800), {primary}, primary);
    QCOMPARE(huge, primary);
    const auto roundtrip = wp::ui::windowGeometryRect(wp::ui::windowGeometrySetting(saved));
    QCOMPARE(roundtrip, saved);
    QVERIFY(primary.contains(wp::ui::fitWindowGeometry({}, {primary}, primary)));
  }
  void fullscreenAndMaximizedSnapshotsKeepNormalGeometry() {
    QWidget window;
    window.setGeometry(80, 70, 620, 380);
    window.show();
    QCoreApplication::processEvents();
    const auto normal = window.geometry();
    window.showFullScreen();
    QCoreApplication::processEvents();
    QCOMPARE(wp::ui::normalWindowGeometry(window, normal), normal);
    window.showNormal();
    QCoreApplication::processEvents();
    window.showMaximized();
    QCoreApplication::processEvents();
    QCOMPARE(wp::ui::normalWindowGeometry(window, normal), normal);
  }
};
QTEST_MAIN(PlayerControlsTests)
#include "player_controls_tests.moc"
