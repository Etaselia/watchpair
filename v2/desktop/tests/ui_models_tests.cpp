#include "ui_models.h"
#include "room_page.h"
#include <QApplication>
#include <QAbstractItemModelTester>
#include <QDrag>
#include <QDragEnterEvent>
#include <QDragMoveEvent>
#include <QDropEvent>
#include <QFontMetrics>
#include <QHeaderView>
#include <QMimeData>
#include <QScopeGuard>
#include <QtTest>
#ifdef Q_OS_WIN
#include <windows.h>
#include <thread>
#endif
namespace {
class QueueDragView final : public QTableView {
public:
  int starts = 0, enters = 0, moves = 0;
  bool enterAccepted = false, dropAccepted = false, finished = false;
protected:
  void startDrag(Qt::DropActions actions) override {
    ++starts;
    QTableView::startDrag(actions);
    finished = true;
  }
  void dragEnterEvent(QDragEnterEvent *event) override {
    ++enters;
    QTableView::dragEnterEvent(event);
    enterAccepted = event->isAccepted();
  }
  void dragMoveEvent(QDragMoveEvent *event) override {
    ++moves;
    QTableView::dragMoveEvent(event);
  }
  void dropEvent(QDropEvent *event) override {
    QTableView::dropEvent(event);
    dropAccepted = event->isAccepted();
  }
};
}
class UiModels final : public QObject {
  Q_OBJECT
private slots:
  void pointerDragNegotiatesAndDropsFilteredQueueRows_data() {
    QTest::addColumn<int>("sourceRow");
    QTest::addColumn<int>("targetRow");
    QTest::addColumn<int>("targetColumn");
    QTest::addColumn<int>("verticalOffset");
    QTest::newRow("title-top-edge") << 1 << 0 << 0 << -14;
    QTest::newRow("title-upper-half") << 1 << 0 << 0 << -4;
    QTest::newRow("length-upper-half") << 1 << 0 << 2 << -4;
    QTest::newRow("title-lower-half") << 0 << 1 << 0 << 4;
    QTest::newRow("length-bottom-edge") << 0 << 1 << 2 << 14;
    QTest::newRow("approval-bottom-edge") << 0 << 1 << 4 << 14;
  }
  void pointerDragNegotiatesAndDropsFilteredQueueRows() {
#ifndef Q_OS_WIN
    QSKIP("This pointer regression uses the native Windows drag backend");
#else
    if (QGuiApplication::platformName() != QStringLiteral("windows"))
      QSKIP("Run this pointer regression with QT_QPA_PLATFORM=windows");
    if (GetAsyncKeyState(VK_LBUTTON) & 0x8000)
      QSKIP("Release the physical pointer before running the native drag regression");
    QFETCH(int, sourceRow);
    QFETCH(int, targetRow);
    QFETCH(int, targetColumn);
    QFETCH(int, verticalOffset);
    wp::ui::JsonTable model(wp::ui::JsonKind::Queue);
    wp::ui::QueueProxy proxy;
    proxy.setSourceModel(&model);
    proxy.setContext(QStringLiteral("room"), 7);
    QJsonArray rows;
    for (const auto &id : {QStringLiteral("a"), QStringLiteral("b"), QStringLiteral("c"), QStringLiteral("d")})
      rows.append(QJsonObject{{QStringLiteral("id"), id}, {QStringLiteral("enabled"), true},
        {QStringLiteral("watchedAt"), QJsonValue::Null}, {QStringLiteral("label"), QStringLiteral("Episode 1")},
        {QStringLiteral("path"), (id == QStringLiteral("b") || id == QStringLiteral("c"))
            ? QStringLiteral("Season 2/Episode 1.mkv") : QStringLiteral("Season 1/Episode 1.mkv")}});
    model.setRows(rows);
    proxy.search(QStringLiteral("Season 2"));
    QueueDragView view;
    view.setModel(&proxy);
    view.setSelectionBehavior(QAbstractItemView::SelectRows);
    view.setSelectionMode(QAbstractItemView::ExtendedSelection);
    view.setDragEnabled(true);
    view.setAcceptDrops(true);
    view.setDropIndicatorShown(true);
    view.setDragDropMode(QAbstractItemView::InternalMove);
    view.setDragDropOverwriteMode(false);
    view.setDefaultDropAction(Qt::MoveAction);
    view.setEditTriggers(QAbstractItemView::NoEditTriggers);
    view.verticalHeader()->setDefaultSectionSize(34);
    view.horizontalHeader()->setSectionResizeMode(0, QHeaderView::Stretch);
    view.hideColumn(1);
    view.hideColumn(3);
    view.setColumnWidth(2, 70);
    view.resize(500, 240);
    view.show();
    QVERIFY(QTest::qWaitForWindowExposed(&view));
    const auto handle = reinterpret_cast<HWND>(view.winId());
    ShowWindow(handle, SW_SHOWNORMAL);
    SetWindowPos(handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
    SetForegroundWindow(handle);
    view.doItemsLayout();
    const auto source = view.visualRect(proxy.index(sourceRow, 0)).center();
    const auto targetRect = view.visualRect(proxy.index(targetRow, targetColumn));
    const auto target = targetRect.center() + QPoint(0, verticalOffset);
    QVERIFY(view.viewport()->rect().contains(source));
    QVERIFY(view.viewport()->rect().contains(target));
    QSignalSpy reordered(&proxy, &wp::ui::QueueProxy::reorderRequested);
    auto nativePoint = [&](const QPoint &point) {
      const auto local = view.viewport()->mapTo(&view, point);
      POINT native{qRound(local.x() * view.devicePixelRatioF()),
                   qRound(local.y() * view.devicePixelRatioF())};
      ClientToScreen(handle, &native);
      return QPoint(native.x, native.y);
    };
    const auto from = nativePoint(source), to = nativePoint(target);
    POINT original{};
    GetCursorPos(&original);
    bool pressed = false, released = false, ownWindowHit = false;
    // Feed OS pointer events while the GUI thread is inside the real OLE drag
    // loop. Synthetic dropMimeData calls never exercise drag negotiation.
    std::thread pointer([&] {
      SetCursorPos(from.x(), from.y());
      const auto hit = WindowFromPoint(POINT{from.x(), from.y()});
      ownWindowHit = hit == handle || IsChild(handle, hit);
      INPUT input{};
      input.type = INPUT_MOUSE;
      input.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
      pressed = SendInput(1, &input, sizeof(input)) == 1;
      Sleep(80);
      for (int step = 1; step <= 12; ++step) {
        const auto point = from + (to - from) * step / 12;
        SetCursorPos(point.x(), point.y());
        Sleep(20);
      }
      Sleep(80);
      input.mi.dwFlags = MOUSEEVENTF_LEFTUP;
      released = SendInput(1, &input, sizeof(input)) == 1;
      // Always leave the native drag loop bounded, even if Windows rejected
      // an input event or another desktop window took focus during the test.
      Sleep(500);
      INPUT escape{};
      escape.type = INPUT_KEYBOARD;
      escape.ki.wVk = VK_ESCAPE;
      SendInput(1, &escape, sizeof(escape));
      escape.ki.dwFlags = KEYEVENTF_KEYUP;
      SendInput(1, &escape, sizeof(escape));
    });
    const auto restorePointer = qScopeGuard([&] {
      if (pointer.joinable())
        pointer.join();
      SetCursorPos(original.x, original.y);
    });
    QTest::qWait(1100);
    pointer.join();
    qInfo() << "Queue drag events" << view.starts << view.enters << view.moves
            << "accepted" << view.enterAccepted << view.dropAccepted
            << "input" << pressed << released << ownWindowHit
            << "visible" << bool(IsWindowVisible(handle));
    QVERIFY(pressed);
    QVERIFY(released);
    QVERIFY(ownWindowHit);
    QCOMPARE(view.starts, 1);
    QVERIFY(view.enters > 0);
    QVERIFY(view.enterAccepted);
    QVERIFY(view.dropAccepted);
    QCOMPARE(reordered.size(), 1);
    QCOMPARE(reordered.first()[0].toStringList(),
             (QStringList{QStringLiteral("a"), QStringLiteral("c"), QStringLiteral("b"), QStringLiteral("d")}));
    QCOMPARE(reordered.first()[1].toLongLong(), 7);
    QCOMPARE(model.index(1, 0).data(wp::ui::IdRole).toString(), QStringLiteral("b"));
#endif
  }
  void identicalPathsFromDifferentSourcesHaveDistinctCaptionsWithoutChangingIdentity() {
    for (const auto kind : {wp::ui::JsonKind::Queue, wp::ui::JsonKind::History}) {
      wp::ui::JsonTable model(kind);
      QJsonObject first{{QStringLiteral("id"), QStringLiteral("entry-a")},
        {QStringLiteral("sourceId"), QStringLiteral("torrent-a")},
        {QStringLiteral("sourceLabel"), QStringLiteral("Same show")},
        {QStringLiteral("label"), QStringLiteral("Episode 1")},
        {QStringLiteral("path"), QStringLiteral("A show with a very long series title/Season 1/Episode 1.mkv")}};
      auto second = first;
      second.insert(QStringLiteral("id"), QStringLiteral("entry-b"));
      second.insert(QStringLiteral("sourceId"), QStringLiteral("torrent-b"));
      model.setRows({first, second});
      QVERIFY(model.index(0, 0).data().toString() != model.index(1, 0).data().toString());
      QVERIFY(model.index(0, 0).data().toString().contains(QStringLiteral("Same show")));
      QCOMPARE(model.index(0, 0).data(wp::ui::IdRole).toString(), QStringLiteral("entry-a"));
      QCOMPARE(model.index(1, 0).data(wp::ui::IdRole).toString(), QStringLiteral("entry-b"));
      QVERIFY(model.index(1, 0).data(Qt::ToolTipRole).toString().contains(QStringLiteral("torrent-b")));
      QVERIFY(model.index(0, 0).data(wp::ui::SearchRole).toString().contains(QStringLiteral("Same show")));
      second.insert(QStringLiteral("sourceLabel"), QStringLiteral("Different edition"));
      model.setRows({first, second});
      QVERIFY(!model.index(0, 0).data().toString().contains(QLatin1Char('[')));
      QVERIFY(model.index(1, 0).data().toString().contains(QStringLiteral("Different edition")));
      // A compact table must keep the episode number before eliding context.
      const QFontMetrics metrics(QApplication::font());
      for (int row = 0; row < model.rowCount(); ++row) {
        const auto visible = metrics.elidedText(model.index(row, 0).data().toString(), Qt::ElideRight, 150);
        QVERIFY2(visible.contains(QStringLiteral("Episode 1")), qPrintable(visible));
        QVERIFY(model.index(row, 0).data(Qt::ToolTipRole).toString().contains(QStringLiteral("Season 1/Episode 1.mkv")));
      }
    }
  }
  void fractionalEpochMillisecondsAndMissingTimesNeverDisplayTheEpochAsHistory() {
    const auto now = QDateTime::currentMSecsSinceEpoch();
    QCOMPARE(wp::ui::timestampMilliseconds(QJsonValue(double(now) + .75)).value(), now);
    QVERIFY(!wp::ui::timestampMilliseconds(QJsonValue::Null));
    QVERIFY(!wp::ui::timestampMilliseconds(QStringLiteral("1800000000000")));
    QCOMPARE(wp::ui::age(0, now), QStringLiteral("—"));
    wp::ui::JsonTable history(wp::ui::JsonKind::History);
    history.setRows({QJsonObject{{QStringLiteral("id"), QStringLiteral("one")},
      {QStringLiteral("label"), QStringLiteral("Episode 1")},
      {QStringLiteral("watchedAt"), double(now) + .75}}});
    QCOMPARE(history.index(0, 1).data().toString(), QStringLiteral("just now"));
    QCOMPARE(history.index(0, 1).data(wp::ui::SortRole).toLongLong(), now);
    QVERIFY(!history.index(0, 1).data(Qt::ToolTipRole).toString().contains(QStringLiteral("1970")));
    history.setRows({QJsonObject{{QStringLiteral("id"), QStringLiteral("one")}, {QStringLiteral("watchedAt"), QJsonValue::Null}}});
    QCOMPARE(history.index(0, 1).data().toString(), QStringLiteral("—"));
  }
  void filteredDuplicateNamesMoveToWatchedByEntryIdAndDisappearImmediately() {
    wp::ui::JsonTable model(wp::ui::JsonKind::Queue);
    wp::ui::QueueProxy proxy;
    proxy.setSourceModel(&model);
    QAbstractItemModelTester check(&proxy, QAbstractItemModelTester::FailureReportingMode::QtTest);
    QJsonObject first{{QStringLiteral("id"), QStringLiteral("season-one")},
      {QStringLiteral("label"), QStringLiteral("Episode 1")},
      {QStringLiteral("path"), QStringLiteral("Show/Season 1/Episode 1.mkv")},
      {QStringLiteral("enabled"), true}, {QStringLiteral("watchedAt"), QJsonValue::Null}};
    auto second = first;
    second.insert(QStringLiteral("id"), QStringLiteral("season-two"));
    second.insert(QStringLiteral("path"), QStringLiteral("Show/Season 2/Episode 1.mkv"));
    model.setRows({first, second});
    proxy.search(QStringLiteral("Season 2"));
    QCOMPARE(proxy.rowCount(), 1);
    QCOMPARE(proxy.index(0, 0).data(wp::ui::IdRole).toString(), QStringLiteral("season-two"));
    second.insert(QStringLiteral("watchedAt"), 1800000000000.75);
    model.setRows({first, second});
    QCOMPARE(proxy.rowCount(), 0);
    proxy.search({});
    QCOMPARE(proxy.rowCount(), 1);
    QCOMPARE(proxy.index(0, 0).data(wp::ui::IdRole).toString(), QStringLiteral("season-one"));
  }
  void queueDropUsesStableIdsAndOriginalRevisionWhileRetainingHiddenRows() {
    wp::ui::JsonTable model(wp::ui::JsonKind::Queue);
    wp::ui::QueueProxy proxy;
    proxy.setSourceModel(&model);
    proxy.setContext(QStringLiteral("room"), 7);
    QJsonArray rows;
    for (const auto &id : {QStringLiteral("a"), QStringLiteral("b"), QStringLiteral("c"), QStringLiteral("d")})
      rows.append(QJsonObject{{QStringLiteral("id"), id}, {QStringLiteral("enabled"), true},
        {QStringLiteral("watchedAt"), QJsonValue::Null}, {QStringLiteral("label"), QStringLiteral("Episode 1")},
        {QStringLiteral("path"), (id == QStringLiteral("b") || id == QStringLiteral("c")) ? QStringLiteral("Season 2/Episode 1.mkv") : QStringLiteral("Season 1/Episode 1.mkv")}});
    model.setRows(rows);
    proxy.search(QStringLiteral("Season 2"));
    QSignalSpy reordered(&proxy, &wp::ui::QueueProxy::reorderRequested);
    std::unique_ptr<QMimeData> drag(proxy.mimeData({proxy.index(1, 0)}));
    QVERIFY(proxy.canDropMimeData(drag.get(), Qt::MoveAction, 0, 0, {}));
    QVERIFY(proxy.dropMimeData(drag.get(), Qt::MoveAction, 0, 0, {}));
    QCOMPARE(reordered.size(), 1);
    QCOMPARE(reordered.first()[0].toStringList(), (QStringList{QStringLiteral("a"), QStringLiteral("c"), QStringLiteral("b"), QStringLiteral("d")}));
    QCOMPARE(reordered.first()[1].toLongLong(), 7);
    QCOMPARE(model.index(1, 0).data(wp::ui::IdRole).toString(), QStringLiteral("b")); // Wait for the server's accepted order.
    QVERIFY(proxy.canDropMimeData(drag.get(), Qt::MoveAction, 0, 2, {}));
    std::unique_ptr<QMimeData> first(proxy.mimeData({proxy.index(0, 0)}));
    QVERIFY(proxy.canDropMimeData(first.get(), Qt::MoveAction, proxy.rowCount(), 4, {}));
    QVERIFY(proxy.dropMimeData(first.get(), Qt::MoveAction, proxy.rowCount(), 4, {}));
    QCOMPARE(reordered.last()[0].toStringList(),
             (QStringList{QStringLiteral("a"), QStringLiteral("c"), QStringLiteral("b"), QStringLiteral("d")}));
    QCOMPARE(reordered.size(), 2);
    QVERIFY(!proxy.canDropMimeData(first.get(), Qt::CopyAction, 0, 0, {}));
    proxy.setContext(QStringLiteral("room"), 8);
    QVERIFY(!proxy.canDropMimeData(drag.get(), Qt::MoveAction, 0, 0, {}));
    QVERIFY(!proxy.dropMimeData(drag.get(), Qt::MoveAction, 0, 0, {}));
    QCOMPARE(reordered.size(), 2);
    proxy.setContext(QStringLiteral("other-room"), 7);
    QVERIFY(!proxy.canDropMimeData(drag.get(), Qt::MoveAction, 0, 0, {}));
    QVERIFY(!proxy.dropMimeData(drag.get(), Qt::MoveAction, 0, 0, {}));
  }
  void queueDropKeepsMultiSelectionOrderAndRejectsInvalidEntryIds() {
    wp::ui::JsonTable model(wp::ui::JsonKind::Queue);
    wp::ui::QueueProxy proxy;
    proxy.setSourceModel(&model);
    proxy.setContext(QStringLiteral("room"), 9);
    QJsonArray rows;
    for (const auto &id : {QStringLiteral("a"), QStringLiteral("b"), QStringLiteral("c"),
                           QStringLiteral("d"), QStringLiteral("e")})
      rows.append(QJsonObject{{QStringLiteral("id"), id}, {QStringLiteral("enabled"), true},
        {QStringLiteral("watchedAt"), QJsonValue::Null},
        {QStringLiteral("label"), (id == QStringLiteral("b") || id == QStringLiteral("d"))
            ? QStringLiteral("visible duplicate") : QStringLiteral("hidden duplicate")}});
    model.setRows(rows);
    proxy.search(QStringLiteral("visible"));
    QSignalSpy reordered(&proxy, &wp::ui::QueueProxy::reorderRequested);
    std::unique_ptr<QMimeData> drag(proxy.mimeData({proxy.index(1, 0), proxy.index(0, 2), proxy.index(1, 2)}));
    QVERIFY(proxy.canDropMimeData(drag.get(), Qt::MoveAction, 2, 2, {}));
    QVERIFY(proxy.dropMimeData(drag.get(), Qt::MoveAction, 2, 2, {}));
    QCOMPARE(reordered.size(), 1);
    QCOMPARE(reordered.first()[0].toStringList(),
             (QStringList{QStringLiteral("a"), QStringLiteral("c"), QStringLiteral("b"),
                           QStringLiteral("d"), QStringLiteral("e")}));
    QCOMPARE(reordered.first()[1].toLongLong(), 9);
    std::unique_ptr<QMimeData> first(proxy.mimeData({proxy.index(0, 0)}));
    QVERIFY(proxy.dropMimeData(first.get(), Qt::MoveAction, 0, 0, {}));
    QCOMPARE(reordered.size(), 1); // An accepted no-op sends no room command.
    for (const auto &ids : {QJsonArray{QStringLiteral("missing")},
                            QJsonArray{QStringLiteral("b"), QStringLiteral("b")}}) {
      auto envelope = QJsonDocument::fromJson(drag->data(proxy.mimeTypes().first())).object();
      envelope.insert(QStringLiteral("ids"), ids);
      QMimeData invalid;
      invalid.setData(proxy.mimeTypes().first(), QJsonDocument(envelope).toJson());
      QVERIFY(!proxy.canDropMimeData(&invalid, Qt::MoveAction, 0, 0, {}));
      QVERIFY(!proxy.dropMimeData(&invalid, Qt::MoveAction, 0, 0, {}));
    }
    QVERIFY(!proxy.canDropMimeData(drag.get(), Qt::MoveAction, 3, 0, {}));
    QCOMPARE(reordered.size(), 1);
  }
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
