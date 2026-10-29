#include "ui_models.h"
#include <QAbstractItemModelTester>
#include <QtTest>
class UiModels final : public QObject {
  Q_OBJECT
private slots:
  void nestedSelectionRetainsOriginalIndexesAndPriorities() {
    wp::ui::FileTree model;
    QAbstractItemModelTester check(&model, QAbstractItemModelTester::FailureReportingMode::QtTest);
    model.setFiles({{7, QStringLiteral("Show/S01/E02.mkv"), 100, 0},
                    {21, QStringLiteral("Show/S02/E10.mkv"), 200, 100},
                    {90, QStringLiteral("Show/Bonus/Sample.mkv"), 50, 300}},
                   {{7, 4}});
    QCOMPARE(model.selected(), QList<int>{7});
    QCOMPARE(model.selectedBytes(), 100);
    QVERIFY(!model.dirty());
    QVERIFY(model.fileIndex(21).isValid());
    QCOMPARE(model.fileIndex(21).data(wp::ui::IdRole).toInt(), 21);
    const auto root = model.index(0, 0);
    QCOMPARE(root.data(Qt::CheckStateRole).toInt(), int(Qt::PartiallyChecked));
    QVERIFY(model.setData(root, int(Qt::Checked), Qt::CheckStateRole));
    QCOMPARE(model.selectedCount(), 3);
    QCOMPARE(model.selectedBytes(), 350);
    QVERIFY(model.setData(model.index(root.row(), 4, root.parent()), 6, Qt::EditRole));
    for (int p : model.choices())
      QCOMPARE(p, 6);
    QVERIFY(model.setData(root, int(Qt::Unchecked), Qt::CheckStateRole));
    QCOMPARE(model.selectedCount(), 0);
    QVERIFY(model.setData(root, int(Qt::Checked), Qt::CheckStateRole));
    for (int p : model.choices())
      QCOMPARE(p, 6);
    model.chooseAll(true, true);
    QCOMPARE(model.selected(), (QList<int>{7, 21}));
    QVERIFY(model.dirty());
  }
  void tenThousandFilePackUsesBulkSignalsWithoutResettingTheTree() {
    wp::ui::FileTree model;
    QList<wp::TorrentFile> files;
    QHash<int, int> priorities;
    for (int i = 0; i < 10000; ++i) {
      const int index = i * 3 + 7;
      files.append({index, QStringLiteral("Show/S%1/E%2.mkv").arg(i / 100 + 1).arg(i % 100 + 1), 1000000,
                    qint64(i) * 1000000});
      priorities.insert(index, 4);
    }
    QElapsedTimer time;
    time.start();
    model.setFiles(files, priorities);
    QVERIFY2(time.elapsed() < 2500, "Building a 10,000-file chooser must remain responsive");
    QCOMPARE(model.selectedCount(), 10000);
    QCOMPARE(model.selectedBytes(), 10000000000LL);
    QSignalSpy resets(&model, &QAbstractItemModel::modelReset),
        updates(&model, &QAbstractItemModel::dataChanged),
        selection(&model, &wp::ui::FileTree::selectionChanged);
    time.restart();
    model.chooseAll(false);
    model.chooseAll(true, true);
    QVERIFY2(time.elapsed() < 1500, "Folder bulk selection must avoid per-file widget work");
    QCOMPARE(selection.size(), 2);
    QCOMPARE(resets.size(), 0);
    QVERIFY(updates.size() < 250);
    QCOMPARE(model.selectedCount(), 10000);
    QCOMPARE(model.fileIndex(30004).data(wp::ui::IdRole).toInt(), 30004);
  }
  void queueAndWatchedUpdatesKeepStableRowsAndRelativeTimestamps() {
    wp::ui::JsonTable queue(wp::ui::JsonKind::Queue);
    QAbstractItemModelTester check(&queue, QAbstractItemModelTester::FailureReportingMode::QtTest);
    QJsonObject entry{{QStringLiteral("id"), QStringLiteral("one")},
                      {QStringLiteral("label"), QStringLiteral("Episode 1")},
                      {QStringLiteral("enabled"), true},
                      {QStringLiteral("watchedAt"), QJsonValue::Null},
                      {QStringLiteral("duration"), 1500}};
    queue.setRows({entry});
    QPersistentModelIndex selected(queue.index(0, 0));
    QSignalSpy resets(&queue, &QAbstractItemModel::modelReset);
    entry.insert(QStringLiteral("watchedAt"), 1800000000000LL);
    queue.setRows({entry});
    QCOMPARE(resets.size(), 0);
    QVERIFY(selected.isValid());
    QCOMPARE(queue.index(0, 1).data().toString(), QStringLiteral("Watched"));
    QCOMPARE(wp::ui::age(1800000000000LL, 1800000000000LL + 2 * 3600000), QStringLiteral("2 hours ago"));
    QCOMPARE(wp::ui::age(1800000000000LL, 1800000000000LL + 86400000), QStringLiteral("1 day ago"));
    QCOMPARE(wp::ui::elapsed(3661), QStringLiteral("1:01:01"));
  }
};
QTEST_MAIN(UiModels)
#include "ui_models_tests.moc"
