#include "theme.h"
#include "transfer_desk.h"
#include <QApplication>
#include <QDir>
#include <QListWidget>
#include <QHBoxLayout>
#include <QtTest>

class TransferUiTests final : public QObject {
  Q_OBJECT
private slots:
  void filterRowsReserveFontHeightAtDesktopScales() {
    QWidget desk;
    auto *layout = new QHBoxLayout(&desk);
    auto *filters = wp::ui::createTransferFilters(&desk);
    layout->addWidget(filters);
    layout->addStretch();
    desk.resize(900, 640);
    desk.show();
    QVERIFY(QTest::qWaitForWindowExposed(&desk));
    QVERIFY(filters);
    QCOMPARE(filters->count(), 8);
    for (const int pointSize : {10, 15, 22}) {
      auto font = filters->font();
      font.setPointSize(pointSize);
      filters->setFont(font);
      QTest::qWait(100);
      QRect previous;
      for (int row = 0; row < filters->count(); ++row) {
        const auto rect = filters->visualItemRect(filters->item(row));
        QVERIFY2(rect.height() >= filters->fontMetrics().lineSpacing() + 16,
                 "Transfer filter rows must include font height and vertical spacing");
        QVERIFY(!previous.isValid() || previous.bottom() < rect.top());
        QVERIFY(filters->fontMetrics().horizontalAdvance(filters->item(row)->text()) + 24 <= filters->viewport()->width());
        previous = rect;
      }
      const auto output = qEnvironmentVariable("WATCHPAIR_TRANSFER_UI_OUTPUT");
      if (!output.isEmpty()) {
        QDir().mkpath(output);
        QVERIFY(desk.grab().save(QDir(output).filePath(QStringLiteral("transfers-font-%1.png").arg(pointSize))));
      }
    }
  }
};
int main(int argc, char **argv) {
  QApplication app(argc, argv);
  wp::ui::installTheme();
  TransferUiTests tests;
  return QTest::qExec(&tests, argc, argv);
}
#include "transfer_ui_tests.moc"
