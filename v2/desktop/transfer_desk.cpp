#include "transfer_desk.h"
#include "theme.h"
#include <QDateTime>
#include <QDesktopServices>
#include <QDialogButtonBox>
#include <QDoubleSpinBox>
#include <QEvent>
#include <QFileDialog>
#include <QFormLayout>
#include <QGridLayout>
#include <QHBoxLayout>
#include <QHeaderView>
#include <QMenu>
#include <QRegularExpression>
#include <QSignalBlocker>
#include <QSpinBox>
#include <QSplitter>
#include <QStyledItemDelegate>
#include <QStyleOptionViewItem>
#include <QToolButton>
#include <QVBoxLayout>
#include <algorithm>
namespace wp::ui {
namespace {
class FilterDelegate final : public QStyledItemDelegate {
public:
  using QStyledItemDelegate::QStyledItemDelegate;
  QSize sizeHint(const QStyleOptionViewItem &option, const QModelIndex &index) const override {
    auto size = QStyledItemDelegate::sizeHint(option, index);
    size.setHeight(std::max(size.height(), option.fontMetrics.lineSpacing() + 20));
    return size;
  }
};
class FilterList final : public QListWidget {
public:
  explicit FilterList(QWidget *parent = nullptr) : QListWidget(parent) {
    setObjectName(QStringLiteral("TransferFilters"));
    setItemDelegate(new FilterDelegate(this));
    setUniformItemSizes(true);
    setSpacing(2);
    setWordWrap(false);
    setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    fitWidth();
  }
protected:
  void changeEvent(QEvent *event) override {
    QListWidget::changeEvent(event);
    if (event->type() == QEvent::FontChange || event->type() == QEvent::StyleChange ||
        event->type() == QEvent::ApplicationFontChange) {
      fitWidth();
      scheduleDelayedItemsLayout();
    }
  }
private:
  void fitWidth() {
    setFixedWidth(std::max(170, fontMetrics().horizontalAdvance(tr("Metadata / choices")) + 36));
  }
};
QPushButton *button(const QString &text, const QString &glyph, QWidget *parent = nullptr) {
  auto *result = new QPushButton(icon(glyph), text, parent);
  result->setCursor(Qt::PointingHandCursor);
  return result;
}
void tableStyle(QTableView *table) {
  table->setAlternatingRowColors(true);
  table->setShowGrid(false);
  table->setSelectionBehavior(QAbstractItemView::SelectRows);
  table->setSelectionMode(QAbstractItemView::ExtendedSelection);
  table->setSortingEnabled(true);
  table->verticalHeader()->hide();
  table->verticalHeader()->setDefaultSectionSize(31);
  table->horizontalHeader()->setStretchLastSection(false);
  table->setWordWrap(false);
  table->setEditTriggers(QAbstractItemView::NoEditTriggers);
}
void jsonModel(QTableView *view, JsonTable &model) {
  auto *proxy = new QSortFilterProxyModel(view);
  proxy->setSourceModel(&model);
  proxy->setSortRole(SortRole);
  proxy->setSortCaseSensitivity(Qt::CaseInsensitive);
  view->setModel(proxy);
}
QJsonObject selectedJson(QTableView *view, JsonTable &model) {
  const auto *proxy = qobject_cast<QSortFilterProxyModel *>(view->model());
  return model.row(proxy ? proxy->mapToSource(view->currentIndex()).row() : view->currentIndex().row());
}
QHash<int, int> choices(AppServices &app, const QString &id) {
  QHash<int, int> result;
  const auto overrides = app.transfers.intent(id).value(QStringLiteral("overrides")).toObject();
  if (auto *source = app.transfers.source(id))
    for (const auto &file : source->files())
      result.insert(file.index,
                    source->selected(file.index) ? overrides.value(QString::number(file.index)).toInt(4) : 0);
  return result;
}
} // namespace
QListWidget *createTransferFilters(QWidget *parent) {
  auto *filters = new FilterList(parent);
  const QList<QPair<QString, QString>> states{{TransferDesk::tr("All transfers"), {}},
      {TransferDesk::tr("Downloading"), QStringLiteral("Downloading")},
      {TransferDesk::tr("Metadata / choices"), QStringLiteral("Metadata")},
      {TransferDesk::tr("Seeding"), QStringLiteral("Seeding")},
      {TransferDesk::tr("Complete"), QStringLiteral("Complete")},
      {TransferDesk::tr("Paused"), QStringLiteral("Paused")},
      {TransferDesk::tr("Waiting"), QStringLiteral("Waiting")},
      {TransferDesk::tr("Errors"), QStringLiteral("Error")}};
  for (const auto &[text, state] : states) {
    auto *item = new QListWidgetItem(text, filters);
    item->setData(Qt::UserRole, state);
  }
  filters->setCurrentRow(0);
  return filters;
}
FileSelector::FileSelector(QWidget *parent) : QWidget(parent), model(this) {
  auto *layout = new QVBoxLayout(this);
  layout->setContentsMargins(8, 8, 8, 8);
  layout->setSpacing(6);
  auto *tools = new QHBoxLayout;
  auto *search = new QLineEdit;
  search->setPlaceholderText(tr("Search files and folders"));
  search->setClearButtonEnabled(true);
  tools->addWidget(search, 1);
  auto *all = button(tr("All"), QStringLiteral("check")), *none = button(tr("None"), QStringLiteral("x")),
       *episodes = button(tr("Episodes only"), QStringLiteral("play"));
  tools->addWidget(all);
  tools->addWidget(none);
  tools->addWidget(episodes);
  layout->addLayout(tools);
  wait_ = new QLabel;
  wait_->setWordWrap(true);
  wait_->setProperty("muted", true);
  layout->addWidget(wait_);
  auto *proxy = new QSortFilterProxyModel(this);
  proxy->setSourceModel(&model);
  proxy->setRecursiveFilteringEnabled(true);
  proxy->setAutoAcceptChildRows(true);
  proxy->setFilterCaseSensitivity(Qt::CaseInsensitive);
  proxy->setFilterKeyColumn(0);
  tree = new QTreeView;
  tree->setObjectName(QStringLiteral("ContentTree"));
  tree->setModel(proxy);
  tree->setAlternatingRowColors(true);
  tree->setUniformRowHeights(true);
  tree->setSelectionMode(QAbstractItemView::ExtendedSelection);
  tree->setEditTriggers(QAbstractItemView::DoubleClicked | QAbstractItemView::SelectedClicked);
  tree->setItemDelegateForColumn(2, new ProgressDelegate(tree));
  tree->setItemDelegateForColumn(4, new PriorityDelegate(tree));
  tree->header()->setSectionResizeMode(0, QHeaderView::Stretch);
  tree->setColumnWidth(1, 95);
  tree->setColumnWidth(2, 105);
  tree->setColumnWidth(3, 70);
  tree->setColumnWidth(4, 145);
  layout->addWidget(tree, 1);
  summary_ = new QLabel;
  summary_->setProperty("muted", true);
  layout->addWidget(summary_);
  progress_ = new QProgressBar;
  progress_->setRange(0, 0);
  progress_->setTextVisible(false);
  progress_->setFixedHeight(4);
  layout->addWidget(progress_);
  connect(search, &QLineEdit::textChanged, proxy, &QSortFilterProxyModel::setFilterFixedString);
  connect(all, &QPushButton::clicked, this, [this] { model.chooseAll(true); });
  connect(none, &QPushButton::clicked, this, [this] { model.chooseAll(false); });
  connect(episodes, &QPushButton::clicked, this, [this] { model.chooseAll(true, true); });
  connect(&model, &FileTree::selectionChanged, this, [this] {
    summary_->setText(tr("%1 files selected · %2%3")
                          .arg(model.selectedCount())
                          .arg(bytes(model.selectedBytes()))
                          .arg(model.dirty() ? tr(" · Unapplied choices") : QString()));
  });
  loading(tr("Fetching metadata. File choices appear here before any video payload is selected."));
}
void FileSelector::loading(const QString &text, bool busy) {
  wait_->setText(text);
  wait_->show();
  progress_->setVisible(busy);
}
void FileSelector::setFiles(const QList<TorrentFile> &files, const QHash<int, int> &priorities) {
  model.setFiles(files, priorities);
  tree->expandToDepth(1);
  wait_->hide();
  progress_->hide();
}
TorrentChooser::TorrentChooser(AppServices &services, QString transfer, QString room, QWidget *parent)
    : QDialog(parent), app_(services), transfer_(std::move(transfer)), room_(std::move(room)) {
  setAttribute(Qt::WA_DeleteOnClose);
  setWindowTitle(tr("Choose files"));
  resize(940, 710);
  setMinimumSize(720, 540);
  auto *layout = new QVBoxLayout(this);
  auto *title = new QLabel(app_.transfers.view(transfer_).name);
  title->setTextFormat(Qt::PlainText);
  title->setObjectName(QStringLiteral("SectionTitle"));
  layout->addWidget(title);
  auto *description = new QLabel(tr("Choose seasons and episodes first. Extras stay unchecked by default. "
                                    "Your download choices and the room queue have separate scopes."));
  description->setWordWrap(true);
  description->setProperty("muted", true);
  layout->addWidget(description);
  files_ = new FileSelector;
  layout->addWidget(files_, 1);
  shared_ = new QCheckBox(tr("Update the shared room episode queue"));
  shared_->setObjectName(QStringLiteral("SharedSelection"));
  shared_->setChecked(!room_.isEmpty());
  shared_->setEnabled(!room_.isEmpty());
  layout->addWidget(shared_);
  download_ = new QCheckBox(tr("Approve the selected episodes on this device"));
  download_->setChecked(true);
  layout->addWidget(download_);
  follow_ = new QCheckBox(tr("Follow room selection on this device (replace existing manual file choices)"));
  follow_->setChecked(
      app_.transfers.intent(transfer_).value(QStringLiteral("overrides")).toObject().isEmpty());
  layout->addWidget(follow_);
  error_ = new QLabel;
  error_->setWordWrap(true);
  error_->setStyleSheet(QStringLiteral("color:#f1bd94;"));
  error_->hide();
  layout->addWidget(error_);
  auto *controls = new QHBoxLayout;
  auto *cancel = button(tr("Close"), QStringLiteral("x"));
  reload_ = button(tr("Reload room selection"), QStringLiteral("refresh"));
  reload_->hide();
  apply_ = button(tr("Apply selection"), QStringLiteral("check"));
  apply_->setObjectName(QStringLiteral("ApplySelection"));
  apply_->setProperty("role", QStringLiteral("primary"));
  controls->addWidget(cancel);
  controls->addWidget(reload_);
  controls->addStretch();
  controls->addWidget(apply_);
  layout->addLayout(controls);
  connect(cancel, &QPushButton::clicked, this, &QDialog::reject);
  connect(apply_, &QPushButton::clicked, this, &TorrentChooser::apply);
  connect(reload_, &QPushButton::clicked, this, [this] {
    const auto draft = files_->model.choices();
    conflict_ = false;
    manifest(true);
    if (auto *source = app_.transfers.source(transfer_); source && !source->files().isEmpty())
      files_->setFiles(source->files(), draft);
    problem(tr("Your file choices have been kept. Review them against the current room queue, then apply."));
    reload_->hide();
    apply_->setEnabled(initialized_);
  });
  connect(shared_, &QCheckBox::toggled, this, [this](bool shared) {
    download_->setVisible(shared);
    follow_->setVisible(shared);
    apply_->setText(shared ? tr("Apply to room") : tr("Apply on this device"));
  });
  connect(&app_.transfers, &TransferEngine::manifestReady, this, [this](const QString &id) {
    if (id == transfer_)
      manifest();
  });
  connect(&app_.transfers, &TransferEngine::removed, this, [this](const QString &id) {
    if (id == transfer_)
      reject();
  });
  connect(&app_.rooms, &RoomClient::operationComplete, this, [this](const QString &, const QString &op) {
    if (op == operation_)
      accept();
  });
  connect(
      &app_.rooms, &RoomClient::error, this,
      [this](const QString &, const QString &code, const QString &text, const QString &op) {
        if (op != operation_)
          return;
        if (app_.store.get(QStringLiteral("room-command"), op).value(QStringLiteral("state")).toString() ==
            QStringLiteral("pending")) {
          problem(tr("%1 Retrying this same change safely…").arg(text));
          return;
        }
        operation_.clear();
        conflict_ = code == QStringLiteral("QUEUE_CONFLICT");
        reload_->setVisible(conflict_);
        shared_->setEnabled(!room_.isEmpty());
        files_->setEnabled(true);
        apply_->setEnabled(!conflict_);
        problem(text);
      });
  download_->setVisible(!room_.isEmpty());
  follow_->setVisible(!room_.isEmpty());
  apply_->setText(shared_->isChecked() ? tr("Apply to room") : tr("Apply on this device"));
  manifest();
}
void TorrentChooser::manifest(bool reload) {
  auto *source = app_.transfers.source(transfer_);
  if (!source || source->files().isEmpty()) {
    apply_->setEnabled(false);
    files_->loading(app_.transfers.view(transfer_).error.isEmpty()
                        ? tr("Retrieving the torrent file list. No video payload has been approved.")
                        : app_.transfers.view(transfer_).error);
    return;
  }
  if (initialized_ && !reload)
    return;
  auto wanted = choices(app_, transfer_);
  bool existingRoom = false;
  if (!room_.isEmpty() && app_.rooms.connected(room_)) {
    const auto snapshot = app_.rooms.room(room_);
    queueRevision_ = snapshot.value(QStringLiteral("queueRevision")).toInteger();
    const auto identity = app_.transfers.view(transfer_).identity;
    for (auto value : snapshot.value(QStringLiteral("entries")).toArray()) {
      const auto entry = value.toObject();
      if (entry.value(QStringLiteral("sourceId")).toString() == identity) {
        existingRoom = true;
        wanted[entry.value(QStringLiteral("fileIndex")).toInt()] =
            entry.value(QStringLiteral("enabled")).toBool() ? 4 : 0;
      }
    }
  }
  if (!existingRoom && !initialized_ && source->files().size() &&
      std::none_of(wanted.begin(), wanted.end(), [](int p) { return p > 0; }))
    for (const auto &file : source->files())
      wanted[file.index] = TransferEngine::video(file.path) && !TransferEngine::extra(file.path) ? 4 : 0;
  if (!existingRoom && initialized_ && reload)
    wanted = files_->model.choices();
  files_->setFiles(source->files(), wanted);
  initialized_ = true;
  apply_->setEnabled(true);
}
void TorrentChooser::problem(const QString &text) {
  error_->setText(text);
  error_->show();
}
void TorrentChooser::apply() {
  try {
    if (!initialized_ || conflict_)
      return;
    if (shared_->isChecked()) {
      operation_ = app_.media.publishTorrent(transfer_, room_, files_->model.selected(),
                                             download_->isChecked(), follow_->isChecked(), queueRevision_);
      files_->setEnabled(false);
      shared_->setEnabled(false);
      apply_->setEnabled(false);
      problem(tr("Confirming the shared selection…"));
    } else {
      app_.transfers.select(transfer_, files_->model.choices());
      accept();
    }
  } catch (const AppError &e) {
    problem(e.message());
  }
}
void TransferProxy::filter(const QString &state, const QString &text) {
  state_ = state;
  text_ = text;
  invalidateFilter();
}
bool TransferProxy::filterAcceptsRow(int row, const QModelIndex &) const {
  const auto *model = qobject_cast<TransferTable *>(sourceModel());
  if (!model)
    return false;
  const auto r = model->row(row);
  const bool state = state_.isEmpty() || r.state == state_ ||
                     (state_ == QStringLiteral("Downloading") && r.state == QStringLiteral("Stalled")) ||
                     (state_ == QStringLiteral("Metadata") && r.state == QStringLiteral("Select files"));
  return state && (text_.isEmpty() || r.name.contains(text_, Qt::CaseInsensitive) ||
                   r.path.contains(text_, Qt::CaseInsensitive));
}
TransferDesk::TransferDesk(AppServices &app, QWidget *parent)
    : QWidget(parent), app_(app), model_(app.transfers, this), proxy_(this),
      peersModel_(JsonKind::Peers, this), trackersModel_(JsonKind::Trackers, this),
      downloadsModel_(JsonKind::Downloads, this) {
  auto *layout = new QVBoxLayout(this);
  layout->setContentsMargins(24, 20, 24, 16);
  auto *title = new QLabel(tr("Transfers"));
  title->setObjectName(QStringLiteral("PageTitle"));
  layout->addWidget(title);
  auto *subtitle =
      new QLabel(tr("Your device's downloads, priorities, bandwidth, and storage — in one place."));
  subtitle->setProperty("muted", true);
  layout->addWidget(subtitle);
  auto *tools = new QHBoxLayout;
  auto *add = button(tr("Add source"), QStringLiteral("plus"));
  add->setObjectName(QStringLiteral("AddSource"));
  add->setProperty("role", QStringLiteral("primary"));
  auto *resume = button(tr("Resume"), QStringLiteral("play")),
       *pause = button(tr("Pause"), QStringLiteral("pause")),
       *remove = button(tr("Remove"), QStringLiteral("trash"));
  auto *up = button(QString(), QStringLiteral("up")), *down = button(QString(), QStringLiteral("down"));
  up->setToolTip(tr("Move up in the download queue"));
  down->setToolTip(tr("Move down in the download queue"));
  auto *more = new QToolButton;
  more->setText(tr("More"));
  more->setPopupMode(QToolButton::InstantPopup);
  auto *menu = new QMenu(more);
  more->setMenu(menu);
  for (auto *b : {add, resume, pause, remove, up, down})
    tools->addWidget(b);
  tools->addWidget(more);
  tools->addStretch();
  search_ = new QLineEdit;
  search_->setPlaceholderText(tr("Filter transfers"));
  search_->setClearButtonEnabled(true);
  search_->setMaximumWidth(280);
  tools->addWidget(search_);
  layout->addLayout(tools);
  auto *body = new QHBoxLayout;
  filters_ = createTransferFilters(this);
  body->addWidget(filters_);
  transferTabs_ = new QTabWidget;
  connect(transferTabs_, &QTabWidget::currentChanged, this,
          [more](int page) { more->setEnabled(page == 0); });
  auto *native = new QWidget;
  auto *nativeLayout = new QVBoxLayout(native);
  nativeLayout->setContentsMargins(0, 0, 0, 0);
  auto *split = new QSplitter(Qt::Vertical);
  proxy_.setSourceModel(&model_);
  proxy_.setSortRole(SortRole);
  table_ = new QTableView;
  table_->setObjectName(QStringLiteral("TorrentTable"));
  table_->setModel(&proxy_);
  tableStyle(table_);
  table_->sortByColumn(0, Qt::AscendingOrder);
  table_->setItemDelegateForColumn(3, new ProgressDelegate(table_));
  const QList<int> widths{38, 275, 90, 105, 130, 55, 55, 90, 90, 70, 65, 260};
  for (int i = 0; i < widths.size(); ++i)
    table_->setColumnWidth(i, widths[i]);
  table_->hideColumn(11);
  table_->horizontalHeader()->setSectionResizeMode(1, QHeaderView::Stretch);
  split->addWidget(table_);
  details_ = new QTabWidget;
  details_->setMinimumHeight(300);
  auto *general = new QWidget;
  auto *generalLayout = new QVBoxLayout(general);
  selectionTitle_ = new QLabel(tr("Select a transfer"));
  selectionTitle_->setObjectName(QStringLiteral("SectionTitle"));
  selectionTitle_->setTextFormat(Qt::PlainText);
  selectionReason_ = new QLabel;
  selectionReason_->setWordWrap(true);
  selectionReason_->setProperty("muted", true);
  stats_ = new QLabel;
  stats_->setWordWrap(true);
  auto *form = new QFormLayout;
  location_ = new QLineEdit;
  location_->setReadOnly(true);
  identity_ = new QLineEdit;
  identity_->setReadOnly(true);
  form->addRow(tr("Save location"), location_);
  form->addRow(tr("Content identity"), identity_);
  generalLayout->addWidget(selectionTitle_);
  generalLayout->addWidget(selectionReason_);
  generalLayout->addWidget(stats_);
  generalLayout->addLayout(form);
  generalLayout->addStretch();
  details_->addTab(general, tr("General"));
  auto *content = new QWidget;
  auto *contentLayout = new QVBoxLayout(content);
  contentLayout->setContentsMargins(0, 0, 0, 6);
  files_ = new FileSelector;
  contentLayout->addWidget(files_, 1);
  contentMessage_ = new QLabel;
  contentMessage_->setTextFormat(Qt::PlainText);
  contentMessage_->setWordWrap(true);
  contentMessage_->setProperty("muted", true);
  contentLayout->addWidget(contentMessage_);
  auto *contentTools = new QHBoxLayout;
  auto *follow = button(tr("Follow room choices"), QStringLiteral("refresh"));
  follow->setToolTip(tr("Clear manual file priorities and use the approved room selections on this device."));
  applyFiles_ = button(tr("Apply on this device"), QStringLiteral("check"));
  applyFiles_->setProperty("role", QStringLiteral("primary"));
  applyFiles_->setObjectName(QStringLiteral("ApplyContentSelection"));
  contentTools->addWidget(follow);
  scope_ = new QComboBox;
  scope_->setObjectName(QStringLiteral("ContentScope"));
  scope_->setAccessibleName(tr("File selection scope"));
  scope_->setMinimumContentsLength(12);
  scope_->setSizeAdjustPolicy(QComboBox::AdjustToMinimumContentsLengthWithIcon);
  contentTools->addWidget(scope_, 1);
  reloadContent_ = button(tr("Review current queue"), QStringLiteral("refresh"));
  reloadContent_->hide();
  contentTools->addWidget(reloadContent_);
  contentTools->addStretch();
  contentTools->addWidget(applyFiles_);
  contentLayout->addLayout(contentTools);
  details_->addTab(content, tr("Content"));
  auto *trackerPage = new QWidget;
  auto *trackerLayout = new QVBoxLayout(trackerPage);
  auto *trackerTools = new QHBoxLayout;
  auto *edit = button(tr("Edit trackers"), QStringLiteral("settings")),
       *announce = button(tr("Reannounce"), QStringLiteral("refresh"));
  trackerTools->addWidget(edit);
  trackerTools->addWidget(announce);
  trackerTools->addStretch();
  trackerLayout->addLayout(trackerTools);
  trackers_ = new QTableView;
  jsonModel(trackers_, trackersModel_);
  tableStyle(trackers_);
  trackers_->horizontalHeader()->setSectionResizeMode(0, QHeaderView::Stretch);
  trackerLayout->addWidget(trackers_);
  details_->addTab(trackerPage, tr("Trackers"));
  peers_ = new QTableView;
  jsonModel(peers_, peersModel_);
  tableStyle(peers_);
  peers_->horizontalHeader()->setSectionResizeMode(1, QHeaderView::Stretch);
  peers_->setItemDelegateForColumn(2, new ProgressDelegate(peers_));
  details_->addTab(peers_, tr("Peers"));
  activity_ = new QPlainTextEdit;
  activity_->setReadOnly(true);
  activity_->setMaximumBlockCount(500);
  details_->addTab(activity_, tr("Activity"));
  split->addWidget(details_);
  split->setSizes({330, 380});
  nativeLayout->addWidget(split);
  transferTabs_->addTab(native, tr("Torrents"));
  downloads_ = new QTableView;
  jsonModel(downloads_, downloadsModel_);
  tableStyle(downloads_);
  downloads_->horizontalHeader()->setSectionResizeMode(0, QHeaderView::Stretch);
  downloads_->setItemDelegateForColumn(2, new ProgressDelegate(downloads_));
  transferTabs_->addTab(downloads_, tr("Other transfers"));
  body->addWidget(transferTabs_, 1);
  layout->addLayout(body, 1);
  connect(add, &QPushButton::clicked, this, &TransferDesk::addRequested);
  connect(resume, &QPushButton::clicked, this, [this] {
    if (transferTabs_->currentIndex() == 1) {
      const auto row = selectedJson(downloads_, downloadsModel_);
      guard([&] {
        if (row.value(QStringLiteral("kind")).toString() == QStringLiteral("share"))
          app_.sharing.resume(row.value(QStringLiteral("id")).toString());
        else
          app_.direct.resume(row.value(QStringLiteral("id")).toString());
      });
    } else
      actionSelected([this](const QString &id) { app_.transfers.setPaused(id, false); });
  });
  connect(pause, &QPushButton::clicked, this, [this] {
    if (transferTabs_->currentIndex() == 1) {
      const auto row = selectedJson(downloads_, downloadsModel_);
      guard([&] {
        if (row.value(QStringLiteral("kind")).toString() == QStringLiteral("share"))
          app_.sharing.pause(row.value(QStringLiteral("id")).toString());
        else
          app_.direct.pause(row.value(QStringLiteral("id")).toString());
      });
    } else
      actionSelected([this](const QString &id) { app_.transfers.setPaused(id, true); });
  });
  connect(remove, &QPushButton::clicked, this, &TransferDesk::removeSelected);
  connect(up, &QPushButton::clicked, this, [this] { guard([this] { moveOrder(-1); }); });
  connect(down, &QPushButton::clicked, this, [this] { guard([this] { moveOrder(1); }); });
  connect(filters_, &QListWidget::currentItemChanged, this, [this](QListWidgetItem *item) {
    proxy_.filter(item ? item->data(Qt::UserRole).toString() : QString(), search_->text());
  });
  connect(search_, &QLineEdit::textChanged, this, [this](const QString &text) {
    proxy_.filter(
        filters_->currentItem() ? filters_->currentItem()->data(Qt::UserRole).toString() : QString(), text);
  });
  connect(table_->selectionModel(), &QItemSelectionModel::currentRowChanged, this, [this] { selection(); });
  connect(&files_->model, &FileTree::selectionChanged, this, [this] {
    if (files_->model.dirty() && !contentDirty_ && !scope_->currentData().toString().isEmpty())
      guard([this] {
        contentRevision_ = app_.rooms.room(scope_->currentData().toString())
                               .value(QStringLiteral("queueRevision"))
                               .toInteger();
      });
    contentDirty_ = files_->model.dirty();
    contentState();
  });
  connect(scope_, qOverload<int>(&QComboBox::activated), this, [this] {
    guard([this] {
      const auto room = scope_->currentData().toString();
      contentScopes_.insert(current_, room);
      const bool dirty = files_->model.dirty();
      const auto draft = files_->model.choices();
      files_->setFiles(app_.transfers.source(current_)->files(), contentChoices());
      if (dirty)
        files_->model.setDraft(draft);
      contentRevision_ =
          room.isEmpty() ? -1 : app_.rooms.room(room).value(QStringLiteral("queueRevision")).toInteger();
      contentState();
    });
  });
  connect(reloadContent_, &QPushButton::clicked, this, [this] {
    guard([this] {
      contentRevision_ = app_.rooms.room(scope_->currentData().toString())
                             .value(QStringLiteral("queueRevision"))
                             .toInteger();
      reloadContent_->hide();
      contentMessage_->setText(
          tr("Your choices have been kept. Review them, then apply to the current shared queue."));
      contentState();
    });
  });
  connect(applyFiles_, &QPushButton::clicked, this, [this] {
    guard([this] {
      const auto room = scope_->currentData().toString();
      if (room.isEmpty()) {
        app_.transfers.select(current_, files_->model.choices());
        files_->setFiles(app_.transfers.source(current_)->files(), choices(app_, current_));
        contentDirty_ = false;
      } else {
        const auto op =
            app_.media.publishTorrent(current_, room, files_->model.selected(), true, true, contentRevision_);
        contentOperations_.insert(op, current_);
      }
      contentState();
    });
  });
  connect(&app_.rooms, &RoomClient::operationComplete, this, [this](const QString &, const QString &op) {
    if (!contentOperations_.contains(op))
      return;
    const auto transfer = contentOperations_.take(op);
    if (current_ == transfer && app_.transfers.source(current_)) {
      files_->setFiles(app_.transfers.source(current_)->files(), contentChoices());
      contentDirty_ = false;
      contentMessage_->setText(tr("Selection saved."));
      contentState();
    }
  });
  connect(
      &app_.rooms, &RoomClient::error, this,
      [this](const QString &, const QString &code, const QString &message, const QString &op) {
        if (!contentOperations_.contains(op) ||
            app_.store.get(QStringLiteral("room-command"), op).value(QStringLiteral("state")).toString() ==
                QStringLiteral("pending"))
          return;
        const auto transfer = contentOperations_.take(op);
        if (current_ == transfer) {
          contentState();
          contentMessage_->setText(message);
          reloadContent_->setVisible(code == QStringLiteral("QUEUE_CONFLICT"));
        }
      });
  connect(follow, &QPushButton::clicked, this, [this] {
    guard([this] {
      app_.transfers.followRoomSelection(current_);
      files_->setFiles(app_.transfers.source(current_)->files(), contentChoices());
    });
  });
  connect(edit, &QPushButton::clicked, this, &TransferDesk::editTrackers);
  connect(announce, &QPushButton::clicked, this,
          [this] { actionSelected([this](const QString &id) { app_.transfers.reannounce(id); }); });
  auto *open = menu->addAction(icon(QStringLiteral("folder")), tr("Open save location"));
  connect(open, &QAction::triggered, this, [this] {
    if (!current_.isEmpty())
      guard([this] { QDesktopServices::openUrl(QUrl::fromLocalFile(app_.transfers.view(current_).path)); });
  });
  auto *move = menu->addAction(tr("Move storage…"));
  connect(move, &QAction::triggered, this, &TransferDesk::moveStorage);
  auto *limits = menu->addAction(tr("Speed and seeding limits…"));
  connect(limits, &QAction::triggered, this, &TransferDesk::editLimits);
  auto *recheck = menu->addAction(tr("Recheck verified pieces"));
  connect(recheck, &QAction::triggered, this,
          [this] { actionSelected([this](const QString &id) { app_.transfers.recheck(id); }); });
  auto *retry = menu->addAction(tr("Retry / repair"));
  connect(retry, &QAction::triggered, this,
          [this] { actionSelected([this](const QString &id) { app_.transfers.retry(id); }); });
  auto *pin = menu->addAction(tr("Toggle storage pin"));
  connect(pin, &QAction::triggered, this, [this] {
    actionSelected(
        [this](const QString &id) { app_.transfers.setPinned(id, !app_.transfers.view(id).pinned); });
  });
  menu->addSeparator();
  auto *publish = menu->addAction(tr("Choose episodes for the room…"));
  connect(publish, &QAction::triggered, this, [this] {
    if (!current_.isEmpty())
      emit publishRequested(current_);
  });
  connect(&app_.transfers, &TransferEngine::manifestReady, this, [this](const QString &id) {
    if (id == current_ && !files_->model.dirty())
      files_->setFiles(app_.transfers.source(id)->files(), contentChoices());
  });
  connect(&app_.rooms, &RoomClient::queueChanged, this, [this](const QString &room) {
    if (!current_.isEmpty() && scope_->currentData().toString() == room)
      refresh();
  });
  connect(&refresh_, &QTimer::timeout, this, &TransferDesk::refresh);
  refresh_.start(1000);
  refresh();
}
QStringList TransferDesk::selected() const {
  if (transferTabs_->currentIndex() != 0)
    return {};
  QStringList result;
  for (const auto &index : table_->selectionModel()->selectedRows())
    result.append(proxy_.mapToSource(index).data(IdRole).toString());
  return result;
}
void TransferDesk::guard(const std::function<void()> &action) {
  try {
    action();
  } catch (const AppError &e) {
    emit error(e.code(), e.message());
  } catch (const std::exception &e) {
    emit error(QStringLiteral("TRANSFER_ACTION"), QString::fromUtf8(e.what()));
  }
}
void TransferDesk::actionSelected(const std::function<void(const QString &)> &action) {
  for (const auto &id : selected())
    guard([&] { action(id); });
}
void TransferDesk::showTransfer(const QString &id) {
  if (id.startsWith(QStringLiteral("sha256:"))) {
    refresh();
    const int row = downloadsModel_.indexOf(id);
    if (row >= 0) {
      transferTabs_->setCurrentIndex(1);
      auto *proxy = qobject_cast<QSortFilterProxyModel *>(downloads_->model());
      downloads_->setCurrentIndex(proxy ? proxy->mapFromSource(downloadsModel_.index(row, 0))
                                        : downloadsModel_.index(row, 0));
    }
    return;
  }
  model_.refresh();
  const auto source = model_.index(model_.indexOf(id), 0);
  const auto index = proxy_.mapFromSource(source);
  if (index.isValid()) {
    table_->selectRow(index.row());
    table_->scrollTo(index);
    transferTabs_->setCurrentIndex(0);
    details_->setCurrentIndex(1);
    selection();
  }
}
void TransferDesk::selection() {
  const auto next = table_->currentIndex().isValid()
                        ? proxy_.mapToSource(table_->currentIndex()).data(IdRole).toString()
                        : QString();
  if (next == current_ && files_->model.dirty()) {
    refresh();
    contentState();
    return;
  }
  current_ = table_->currentIndex().isValid()
                 ? proxy_.mapToSource(table_->currentIndex()).data(IdRole).toString()
                 : QString();
  if (current_.isEmpty() || !app_.transfers.source(current_))
    return;
  contentDirty_ = false;
  reloadContent_->hide();
  contentScope();
  auto *source = app_.transfers.source(current_);
  if (!source->files().isEmpty())
    files_->setFiles(source->files(), contentChoices());
  else {
    files_->model.setFiles({}, {});
    files_->loading(tr("Retrieving metadata. The file list will appear here automatically."));
  }
  refresh();
  contentState();
}
void TransferDesk::contentScope() {
  const QSignalBlocker blocker(scope_);
  scope_->clear();
  scope_->addItem(tr("This device only"), QString());
  const auto identity = app_.transfers.view(current_).identity;
  QString defaultRoom;
  for (auto value : app_.rooms.rooms()) {
    const auto room = value.toObject().value(QStringLiteral("key")).toString(),
               name = value.toObject().value(QStringLiteral("name")).toString();
    const auto snapshot = app_.rooms.room(room);
    bool contains = false;
    for (auto source : snapshot.value(QStringLiteral("sources")).toArray())
      if (source.toObject().value(QStringLiteral("id")).toString() == identity)
        contains = true;
    if (!contains)
      continue;
    scope_->addItem(tr("Shared queue · %1").arg(name), room);
    if (snapshot.value(QStringLiteral("hostId")) ==
            app_.rooms.credential(room).value(QStringLiteral("memberId")) &&
        room == app_.playback.room())
      defaultRoom = room;
  }
  const auto target = contentScopes_.contains(current_) ? contentScopes_.value(current_) : defaultRoom;
  const int index = scope_->findData(target);
  scope_->setCurrentIndex(index < 0 ? 0 : index);
  const auto room = scope_->currentData().toString();
  contentRevision_ =
      room.isEmpty() ? -1 : app_.rooms.room(room).value(QStringLiteral("queueRevision")).toInteger();
}
QHash<int, int> TransferDesk::contentChoices() const {
  auto result = choices(app_, current_);
  const auto room = scope_->currentData().toString();
  if (room.isEmpty() || app_.store.get(QStringLiteral("room-private"), room).isEmpty())
    return result;
  const auto identity = app_.transfers.view(current_).identity;
  for (auto value : app_.rooms.room(room).value(QStringLiteral("entries")).toArray()) {
    const auto e = value.toObject();
    if (e.value(QStringLiteral("sourceId")).toString() == identity)
      result[e.value(QStringLiteral("fileIndex")).toInt()] =
          e.value(QStringLiteral("enabled")).toBool() ? 4 : 0;
  }
  return result;
}
void TransferDesk::contentState() {
  const bool pending = contentOperations_.values().contains(current_);
  const auto room = scope_->currentData().toString();
  files_->setEnabled(!pending);
  scope_->setEnabled(!pending);
  applyFiles_->setText(room.isEmpty() ? tr("Apply on this device") : tr("Apply to room + device"));
  applyFiles_->setEnabled(!current_.isEmpty() && !pending && (files_->model.dirty() || !room.isEmpty()) &&
                          (room.isEmpty() || app_.rooms.connected(room)) && !reloadContent_->isVisible());
  if (!reloadContent_->isVisible())
    contentMessage_->setText(
        pending ? tr("Saving the shared selection… You can continue using other transfers.")
        : room.isEmpty()
            ? tr("These file choices affect this device. Choose a shared queue here to update the room too.")
            : tr("These choices update everyone's episode queue and this device's approval. Your manual "
                 "pauses stay in force."));
}
void TransferDesk::refresh() {
  guard([this] {
    auto downloads = app_.direct.downloads();
    for (auto value : app_.sharing.downloads())
      downloads.append(value);
    downloadsModel_.setRows(downloads);
    if (current_.isEmpty() || !app_.transfers.source(current_)) {
      current_.clear();
      selectionTitle_->setText(tr("Select a transfer"));
      selectionReason_->setText(tr("Choose a row to inspect its content, trackers, peers, and storage."));
      stats_->clear();
      location_->clear();
      identity_->clear();
      applyFiles_->setEnabled(false);
      if (files_->model.rowCount())
        files_->model.setFiles({}, {});
      files_->loading(tr("Select a transfer to see its files."), false);
      peersModel_.setRows({});
      trackersModel_.setRows({});
      activity_->clear();
      return;
    }
    const auto r = app_.transfers.view(current_);
    selectionTitle_->setText(r.name);
    selectionReason_->setText(r.reason.isEmpty() ? r.state : r.state + QStringLiteral(" · ") + r.reason);
    stats_->setText(tr("Verified %1 of %2 selected · %3 peers · Uploaded %4%5%6%7")
                        .arg(bytes(r.verified), bytes(r.wanted))
                        .arg(r.peers)
                        .arg(bytes(r.uploaded))
                        .arg(r.pinned ? tr(" · Pinned") : QString())
                        .arg(r.inUse ? tr(" · In use") : QString())
                        .arg(r.seedPolicy == QStringLiteral("off") ? tr(" · Torrent uploads off")
                             : r.uploadsEnabled ? tr(" · Torrent uploads enabled")
                                                : tr(" · Torrent upload limit reached or paused")));
    location_->setText(r.path);
    identity_->setText(r.identity);
    if (details_->currentIndex() == 1 && !app_.transfers.source(current_)->files().isEmpty()) {
      files_->model.syncChoices(contentChoices());
      files_->model.setProgress(app_.transfers.fileProgress(current_));
      const auto room = scope_->currentData().toString();
      if (!files_->model.dirty() && !reloadContent_->isVisible() && !room.isEmpty() &&
          app_.rooms.connected(room))
        contentRevision_ = app_.rooms.room(room).value(QStringLiteral("queueRevision")).toInteger();
      contentState();
    }
    if (details_->currentIndex() == 2)
      trackersModel_.setRows(app_.transfers.trackers(current_));
    if (details_->currentIndex() == 3)
      peersModel_.setRows(app_.transfers.peers(current_));
    if (details_->currentIndex() == 4) {
      QStringList lines;
      for (auto value : app_.transfers.activity()) {
        const auto row = value.toObject();
        if (row.value(QStringLiteral("transfer")).toString() == current_ ||
            row.value(QStringLiteral("transfer")).toString().isEmpty())
          lines.append(QDateTime::fromMSecsSinceEpoch(row.value(QStringLiteral("at")).toInteger())
                           .toString(QStringLiteral("HH:mm:ss")) +
                       QLatin1Char(' ') + row.value(QStringLiteral("code")).toString() +
                       QStringLiteral("  ") + row.value(QStringLiteral("message")).toString());
      }
      const auto text = lines.join(QLatin1Char('\n'));
      if (activity_->toPlainText() != text)
        activity_->setPlainText(text);
    }
  });
}
void TransferDesk::moveOrder(int direction) {
  if (transferTabs_->currentIndex() == 1) {
    const auto row = selectedJson(downloads_, downloadsModel_);
    if (row.isEmpty())
      return;
    app_.transfers.moveQueue((row.value(QStringLiteral("kind")).toString() == QStringLiteral("share")
                                  ? QStringLiteral("share:")
                                  : QStringLiteral("direct:")) +
                                 row.value(QStringLiteral("id")).toString(),
                             direction);
    return;
  }
  QStringList keys;
  for (const auto &id : selected())
    keys.append(QStringLiteral("torrent:") + id);
  app_.transfers.moveQueueGroup(keys, direction);
}
void TransferDesk::removeSelected() {
  if (transferTabs_->currentIndex() == 1) {
    const auto row = selectedJson(downloads_, downloadsModel_);
    guard([&] {
      if (row.value(QStringLiteral("kind")).toString() == QStringLiteral("share"))
        app_.sharing.remove(row.value(QStringLiteral("id")).toString());
      else
        app_.direct.remove(row.value(QStringLiteral("id")).toString());
    });
    return;
  }
  const auto ids = selected();
  if (ids.isEmpty())
    return;
  auto *dialog = new QDialog(this);
  dialog->setAttribute(Qt::WA_DeleteOnClose);
  dialog->setWindowTitle(tr("Remove transfers"));
  auto *layout = new QVBoxLayout(dialog);
  auto *text = new QLabel(tr("Remove %1 transfer%2 from this device? Room history is retained.")
                              .arg(ids.size())
                              .arg(ids.size() == 1 ? QString() : QStringLiteral("s")));
  text->setWordWrap(true);
  layout->addWidget(text);
  auto *erase = new QCheckBox(tr("Also delete WatchPair-managed files (unrelated files are kept)"));
  layout->addWidget(erase);
  auto *buttons = new QDialogButtonBox(QDialogButtonBox::Cancel | QDialogButtonBox::Ok);
  buttons->button(QDialogButtonBox::Ok)->setText(tr("Remove"));
  layout->addWidget(buttons);
  connect(buttons, &QDialogButtonBox::rejected, dialog, &QDialog::reject);
  connect(buttons, &QDialogButtonBox::accepted, this, [this, dialog, ids, erase] {
    for (const auto &id : ids)
      guard([&] { app_.transfers.remove(id, erase->isChecked()); });
    dialog->accept();
  });
  dialog->open();
}
void TransferDesk::moveStorage() {
  if (current_.isEmpty())
    return;
  const auto id = current_;
  auto *dialog = new QFileDialog(this, tr("Move into a new managed folder"));
  dialog->setFileMode(QFileDialog::Directory);
  dialog->setOption(QFileDialog::ShowDirsOnly);
  dialog->setAttribute(Qt::WA_DeleteOnClose);
  connect(dialog, &QFileDialog::fileSelected, this,
          [this, id](const QString &path) { guard([&] { app_.transfers.relocateMissing(id, path); }); });
  dialog->open();
}
void TransferDesk::editLimits() {
  const auto ids = selected();
  if (ids.isEmpty())
    return;
  auto *dialog = new QDialog(this);
  dialog->setAttribute(Qt::WA_DeleteOnClose);
  dialog->setWindowTitle(tr("Transfer limits"));
  auto *layout = new QFormLayout(dialog);
  auto *policy = new QComboBox;
  policy->setObjectName(QStringLiteral("TransferSeedPolicy"));
  policy->addItem(tr("Use device default"), QStringLiteral("inherit"));
  policy->addItem(tr("Off — no file uploads"), QStringLiteral("off"));
  policy->addItem(tr("Stop at 1× uploaded"), QStringLiteral("ratio1"));
  policy->addItem(tr("Stop at 2× uploaded"), QStringLiteral("ratio2"));
  policy->addItem(tr("Unlimited seeding"), QStringLiteral("unlimited"));
  policy->addItem(tr("Custom ratio / time"), QStringLiteral("custom"));
  auto *down = new QDoubleSpinBox, *up = new QDoubleSpinBox, *ratio = new QDoubleSpinBox;
  for (auto *spin : {down, up}) {
    spin->setRange(0, 2047);
    spin->setDecimals(2);
    spin->setSuffix(tr(" MiB/s"));
    spin->setSpecialValueText(tr("Unlimited (device cap still applies)"));
  }
  ratio->setRange(0, 1000);
  ratio->setDecimals(2);
  ratio->setSpecialValueText(tr("Unlimited"));
  auto *minutes = new QSpinBox;
  minutes->setRange(0, 525600);
  minutes->setSuffix(tr(" minutes"));
  minutes->setSpecialValueText(tr("Unlimited"));
  const auto intent = app_.transfers.intent(ids.first());
  policy->setCurrentIndex(std::max(0, policy->findData(intent.value(QStringLiteral("seedPolicy"))
                                                         .toString(QStringLiteral("inherit")))));
  down->setValue(intent.value(QStringLiteral("downLimit")).toDouble() / 1048576);
  up->setValue(intent.value(QStringLiteral("upLimit")).toDouble() / 1048576);
  ratio->setValue(intent.value(QStringLiteral("seedRatio")).toDouble());
  minutes->setValue(intent.value(QStringLiteral("seedMinutes")).toInt());
  layout->addRow(tr("Download"), down);
  layout->addRow(tr("Upload"), up);
  layout->addRow(tr("Torrent seeding"), policy);
  auto *explanation = new QLabel(tr("Off blocks file payload uploads while downloading and after completion. "
                                    "Torrent protocol and metadata traffic continue. Explicit local-file shares use their own permission."));
  explanation->setWordWrap(true);
  layout->addRow(explanation);
  layout->addRow(tr("Seed ratio"), ratio);
  layout->addRow(tr("Seed time"), minutes);
  auto updatePolicy = [policy, ratio, minutes] {
    const bool custom = policy->currentData().toString() == QStringLiteral("custom");
    ratio->setEnabled(custom);
    minutes->setEnabled(custom);
  };
  connect(policy, &QComboBox::currentIndexChanged, dialog, updatePolicy);
  updatePolicy();
  auto *buttons = new QDialogButtonBox(QDialogButtonBox::Cancel | QDialogButtonBox::Save);
  layout->addRow(buttons);
  connect(buttons, &QDialogButtonBox::rejected, dialog, &QDialog::reject);
  connect(buttons, &QDialogButtonBox::accepted, this, [this, ids, down, up, ratio, minutes, policy, dialog] {
    for (const auto &id : ids)
      guard([&] {
        app_.transfers.setLimits(id, int(down->value() * 1048576), int(up->value() * 1048576), ratio->value(),
                                 minutes->value(), policy->currentData().toString());
      });
    dialog->accept();
  });
  dialog->open();
}
void TransferDesk::editTrackers() {
  if (current_.isEmpty())
    return;
  const auto id = current_;
  auto *dialog = new QDialog(this);
  dialog->setAttribute(Qt::WA_DeleteOnClose);
  dialog->setWindowTitle(tr("Edit trackers"));
  dialog->resize(720, 350);
  auto *layout = new QVBoxLayout(dialog);
  layout->addWidget(new QLabel(tr("One udp://, http://, or https:// tracker URL per line.")));
  auto *text = new QPlainTextEdit;
  QStringList urls;
  for (auto value : app_.transfers.trackers(id))
    urls.append(value.toObject().value(QStringLiteral("url")).toString());
  text->setPlainText(urls.join(QLatin1Char('\n')));
  layout->addWidget(text);
  auto *buttons = new QDialogButtonBox(QDialogButtonBox::Cancel | QDialogButtonBox::Save);
  layout->addWidget(buttons);
  auto loaded = std::make_shared<bool>(app_.transfers.trackersReady(id));
  if (!*loaded) {
    text->setReadOnly(true);
    text->setPlaceholderText(tr("Retrieving trackers…"));
    buttons->button(QDialogButtonBox::Save)->setEnabled(false);
  }
  connect(&app_.transfers, &TransferEngine::detailsChanged, dialog,
          [this, id, text, buttons, loaded](const QString &transfer) {
            if (transfer != id || *loaded || !app_.transfers.trackersReady(id))
              return;
            QStringList urls;
            for (auto value : app_.transfers.trackers(id))
              urls.append(value.toObject().value(QStringLiteral("url")).toString());
            text->setPlainText(urls.join(QLatin1Char('\n')));
            text->setReadOnly(false);
            buttons->button(QDialogButtonBox::Save)->setEnabled(true);
            *loaded = true;
          });
  connect(&app_.transfers, &TransferEngine::removed, dialog, [dialog, id](const QString &transfer) {
    if (id == transfer)
      dialog->reject();
  });
  connect(buttons, &QDialogButtonBox::rejected, dialog, &QDialog::reject);
  connect(buttons, &QDialogButtonBox::accepted, this, [this, id, text, dialog] {
    guard([&] {
      QStringList urls;
      for (const auto &line : text->toPlainText().split(QLatin1Char('\n')))
        if (!line.trimmed().isEmpty())
          urls.append(line.trimmed());
      app_.transfers.setTrackers(id, urls);
      dialog->accept();
    });
  });
  dialog->open();
}
} // namespace wp::ui
