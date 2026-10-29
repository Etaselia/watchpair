#include "room_page.h"
#include "theme.h"
#include <QApplication>
#include <QDialogButtonBox>
#include <QFileInfo>
#include <QGridLayout>
#include <QHBoxLayout>
#include <QHeaderView>
#include <QInputDialog>
#include <QJsonDocument>
#include <QMenu>
#include <QProgressBar>
#include <QSignalBlocker>
#include <QStackedWidget>
#include <QStandardItemModel>
#include <QToolButton>
#include <QVBoxLayout>
#include <algorithm>
namespace wp::ui {
namespace {
QLabel *text(const QString &value, const QString &role = {}) {
  auto *result = new QLabel(value);
  result->setTextFormat(Qt::PlainText);
  if (!role.isEmpty())
    result->setObjectName(role);
  return result;
}
QPushButton *button(const QString &value, const QString &glyph) {
  return new QPushButton(icon(glyph), value);
}
void tableStyle(QTableView *table) {
  table->setAlternatingRowColors(true);
  table->setShowGrid(false);
  table->verticalHeader()->hide();
  table->verticalHeader()->setDefaultSectionSize(34);
  table->setSelectionBehavior(QAbstractItemView::SelectRows);
  table->setSelectionMode(QAbstractItemView::ExtendedSelection);
  table->setEditTriggers(QAbstractItemView::NoEditTriggers);
  table->setWordWrap(false);
}
QString trackLabel(const QJsonObject &t) {
  const QHash<QString, QString> names{
      {QStringLiteral("eng"), QStringLiteral("English")},  {QStringLiteral("en"), QStringLiteral("English")},
      {QStringLiteral("jpn"), QStringLiteral("Japanese")}, {QStringLiteral("ja"), QStringLiteral("Japanese")},
      {QStringLiteral("deu"), QStringLiteral("German")},   {QStringLiteral("ger"), QStringLiteral("German")},
      {QStringLiteral("fra"), QStringLiteral("French")},   {QStringLiteral("spa"), QStringLiteral("Spanish")},
      {QStringLiteral("zho"), QStringLiteral("Chinese")}};
  const auto language = t.value(QStringLiteral("lang")).toString();
  QString label = names.value(language, language.toUpper());
  const auto title = t.value(QStringLiteral("title")).toString();
  if (!title.isEmpty())
    label += (label.isEmpty() ? QString() : QStringLiteral(" · ")) + title;
  if (label.isEmpty())
    label = t.value(QStringLiteral("type")).toString() == QStringLiteral("audio")
                ? QObject::tr("Audio track")
                : QObject::tr("Subtitle track");
  if (!t.value(QStringLiteral("codec")).toString().isEmpty())
    label += QStringLiteral(" · ") + t.value(QStringLiteral("codec")).toString().toUpper();
  return label.left(100);
}
} // namespace
bool QueueProxy::filterAcceptsRow(int row, const QModelIndex &) const {
  const auto *model = qobject_cast<JsonTable *>(sourceModel());
  const auto value = model->row(row);
  return value.value(QStringLiteral("enabled")).toBool() &&
         !value.value(QStringLiteral("watchedAt")).isDouble() &&
         (query_.isEmpty() ||
          value.value(QStringLiteral("label")).toString().contains(query_, Qt::CaseInsensitive) ||
          value.value(QStringLiteral("path")).toString().contains(query_, Qt::CaseInsensitive));
}
RoomPage::RoomPage(AppServices &app, QWidget *parent)
    : QWidget(parent), app_(app), queueModel_(JsonKind::Queue, this), historyModel_(JsonKind::History, this),
      queueProxy_(this), historyProxy_(this) {
  auto *layout = new QVBoxLayout(this);
  layout->setContentsMargins(24, 18, 24, 16);
  layout->setSpacing(12);
  header_ = new QWidget;
  auto *header = new QHBoxLayout(header_);
  header->setContentsMargins(0, 0, 0, 0);
  auto *labels = new QVBoxLayout;
  roomTitle_ = text(tr("Your room"), QStringLiteral("PageTitle"));
  roomSubtitle_ = text(tr("Choose a saved room or create a new one."));
  roomSubtitle_->setProperty("muted", true);
  roomTitle_->setSizePolicy(QSizePolicy::Ignored, QSizePolicy::Preferred);
  roomSubtitle_->setSizePolicy(QSizePolicy::Ignored, QSizePolicy::Preferred);
  labels->addWidget(roomTitle_);
  labels->addWidget(roomSubtitle_);
  header->addLayout(labels, 1);
  auto *add = button(tr("Add media"), QStringLiteral("plus"));
  add->setProperty("role", QStringLiteral("primary"));
  auto *manage = button(tr("Room"), QStringLiteral("settings"));
  policy_ = new QComboBox;
  policy_->addItem(tr("Ask before download"), QStringLiteral("Ask"));
  policy_->addItem(tr("Auto · follow room"), QStringLiteral("Auto"));
  policy_->addItem(tr("Never auto-download"), QStringLiteral("Never"));
  policy_->setToolTip(
      tr("Default policy for new sources on this device. Explicit file choices remain authoritative."));
  header->addWidget(policy_);
  auto *sources = new QToolButton;
  sources->setText(tr("Sources"));
  sources->setPopupMode(QToolButton::InstantPopup);
  auto *sourceMenu = new QMenu(sources);
  sources->setMenu(sourceMenu);
  connect(sourceMenu, &QMenu::aboutToShow, this, [this, sourceMenu] {
    sourceMenu->clear();
    if (room_.isEmpty())
      return;
    for (auto value : app_.rooms.room(room_).value(QStringLiteral("sources")).toArray()) {
      const auto source = value.toObject();
      auto *action = sourceMenu->addAction(
          source.value(QStringLiteral("label")).toString().replace(QLatin1Char('&'), QStringLiteral("&&")));
      connect(action, &QAction::triggered, this, [this, id = source.value(QStringLiteral("id")).toString()] {
        emit sourceFilesRequested(room_, id);
      });
    }
    if (sourceMenu->isEmpty())
      sourceMenu->addAction(tr("No sources yet"))->setEnabled(false);
  });
  header->addWidget(sources);
  header->addWidget(add);
  header->addWidget(manage);
  layout->addWidget(header_);
  split_ = new QSplitter(Qt::Horizontal);
  split_->setChildrenCollapsible(false);
  queuePanel_ = new QWidget;
  queuePanel_->setMinimumWidth(245);
  auto *queueLayout = new QVBoxLayout(queuePanel_);
  queueLayout->setContentsMargins(0, 0, 0, 0);
  queueLayout->setSpacing(7);
  queueTabs_ = new QTabBar;
  queueTabs_->addTab(tr("Upcoming"));
  queueTabs_->addTab(tr("Watched"));
  queueTabs_->setExpanding(true);
  queueLayout->addWidget(queueTabs_);
  auto *search = new QLineEdit;
  search->setPlaceholderText(tr("Find an episode or season"));
  search->setObjectName(QStringLiteral("queueSearch"));
  search->setMaxLength(200);
  search->setClearButtonEnabled(true);
  queueLayout->addWidget(search);
  queueStack_ = new QStackedWidget;
  queueProxy_.setSourceModel(&queueModel_);
  queue_ = new QTableView;
  queue_->setObjectName(QStringLiteral("EpisodeQueue"));
  queue_->setModel(&queueProxy_);
  tableStyle(queue_);
  queue_->horizontalHeader()->setSectionResizeMode(0, QHeaderView::Stretch);
  queue_->setColumnWidth(2, 70);
  queue_->hideColumn(1);
  queue_->hideColumn(3);
  queueStack_->addWidget(queue_);
  historyProxy_.setSourceModel(&historyModel_);
  historyProxy_.setFilterCaseSensitivity(Qt::CaseInsensitive);
  historyProxy_.setFilterKeyColumn(0);
  history_ = new QTableView;
  history_->setObjectName(QStringLiteral("WatchedHistory"));
  history_->setModel(&historyProxy_);
  tableStyle(history_);
  history_->horizontalHeader()->setSectionResizeMode(0, QHeaderView::Stretch);
  history_->setColumnWidth(1, 140);
  history_->hideColumn(2);
  history_->hideColumn(3);
  queueStack_->addWidget(history_);
  queueLayout->addWidget(queueStack_, 1);
  auto *queueTools = new QHBoxLayout;
  auto *up = button(QString(), QStringLiteral("up")), *down = button(QString(), QStringLiteral("down")),
       *watched = button(tr("Watched"), QStringLiteral("check"));
  up->setToolTip(tr("Move episode up"));
  down->setToolTip(tr("Move episode down"));
  auto *queueMore = new QToolButton;
  queueMore->setText(tr("More"));
  queueMore->setPopupMode(QToolButton::InstantPopup);
  auto *queueMenu = new QMenu(queueMore);
  queueMore->setMenu(queueMenu);
  queueTools->addWidget(up);
  queueTools->addWidget(down);
  queueTools->addWidget(watched);
  queueTools->addWidget(queueMore);
  queueLayout->addLayout(queueTools);
  loadHistory_ = button(tr("Load earlier history"), QStringLiteral("clock"));
  loadHistory_->hide();
  queueLayout->addWidget(loadHistory_);
  split_->addWidget(queuePanel_);
  auto *playerPanel = new QWidget;
  auto *playerLayout = new QVBoxLayout(playerPanel);
  playerLayout->setContentsMargins(0, 0, 0, 0);
  playerLayout->setSpacing(8);
  auto *playerHeader = new QHBoxLayout;
  episodeTitle_ = text(tr("Choose an episode"), QStringLiteral("SectionTitle"));
  episodeTitle_->setSizePolicy(QSizePolicy::Ignored, QSizePolicy::Preferred);
  episodeTitle_->setMinimumWidth(0);
  playerHeader->addWidget(episodeTitle_, 1);
  join_ = button(tr("Join watch"), QStringLiteral("play"));
  join_->setObjectName(QStringLiteral("JoinWatch"));
  join_->setProperty("role", QStringLiteral("primary"));
  leave_ = button(tr("Leave watch"), QStringLiteral("x"));
  playerHeader->addWidget(join_);
  playerHeader->addWidget(leave_);
  playerLayout->addLayout(playerHeader);
  auto *frame = new QFrame;
  frame->setObjectName(QStringLiteral("PlayerFrame"));
  frame->setMinimumSize(360, 190);
  auto *frameLayout = new QGridLayout(frame);
  frameLayout->setContentsMargins(1, 1, 1, 1);
  video_ = new VideoWidget(app_.player);
  video_->setObjectName(QStringLiteral("NativeVideo"));
  frameLayout->addWidget(video_, 0, 0);
  overlay_ = new QFrame;
  overlay_->setObjectName(QStringLiteral("PlayerOverlay"));
  auto *overlayLayout = new QVBoxLayout(overlay_);
  overlayLayout->setContentsMargins(28, 20, 28, 20);
  overlayLayout->addStretch();
  auto *overlayIcon = text(QString());
  overlayIcon->setPixmap(icon(QStringLiteral("room"), QColor(QStringLiteral("#8fb7ff"))).pixmap(48, 48));
  overlayIcon->setAlignment(Qt::AlignCenter);
  overlayLayout->addWidget(overlayIcon);
  overlayText_ = text(tr("Join the watch when your copy is ready."));
  overlayText_->setWordWrap(true);
  overlayText_->setAlignment(Qt::AlignCenter);
  overlayLayout->addWidget(overlayText_);
  overlayAction_ = button(tr("Join watch"), QStringLiteral("play"));
  overlayAction_->setMaximumWidth(240);
  overlayAction_->setProperty("role", QStringLiteral("primary"));
  overlayLayout->addWidget(overlayAction_, 0, Qt::AlignHCenter);
  overlayLayout->addStretch();
  frameLayout->addWidget(overlay_, 0, 0);
  playerLayout->addWidget(frame, 1);
  playbackControls_ = new QWidget;
  auto *controls = new QVBoxLayout(playbackControls_);
  controls->setContentsMargins(0, 0, 0, 0);
  controls->setSpacing(9);
  auto *timeline = new QHBoxLayout;
  seek_ = new QSlider(Qt::Horizontal);
  seek_->setObjectName(QStringLiteral("SeekSlider"));
  seek_->setRange(0, 1000000);
  time_ = text(QStringLiteral("0:00 / —"));
  timeline->addWidget(seek_, 1);
  timeline->addWidget(time_);
  controls->addLayout(timeline);
  auto *transport = new QHBoxLayout;
  play_ = button(QString(), QStringLiteral("play"));
  play_->setObjectName(QStringLiteral("PlayPause"));
  play_->setToolTip(tr("Play or pause for the room · Space"));
  next_ = button(QString(), QStringLiteral("next"));
  next_->setToolTip(tr("Next selected episode"));
  state_ = text(tr("Not watching"));
  state_->setSizePolicy(QSizePolicy::Ignored, QSizePolicy::Preferred);
  state_->setProperty("muted", true);
  state_->setMinimumWidth(0);
  rate_ = new QComboBox;
  for (double rate : {0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0})
    rate_->addItem(QString::number(rate) + QStringLiteral("×"), rate);
  rate_->setFixedWidth(79);
  volume_ = new QSlider(Qt::Horizontal);
  volume_->setObjectName(QStringLiteral("Volume"));
  volume_->setRange(0, 130);
  volume_->setValue(int(app_.player.volume()));
  volume_->setMaximumWidth(105);
  auto *volumeIcon = text(QString());
  volumeIcon->setPixmap(icon(QStringLiteral("volume")).pixmap(19, 19));
  auto *full = button(QString(), QStringLiteral("fullscreen"));
  full->setToolTip(tr("Fullscreen · F11"));
  transport->addWidget(play_);
  transport->addWidget(next_);
  transport->addWidget(state_, 1);
  transport->addWidget(rate_);
  transport->addWidget(volumeIcon);
  transport->addWidget(volume_);
  transport->addWidget(full);
  controls->addLayout(transport);
  playerLayout->addWidget(playbackControls_);
  trackControls_ = new QWidget;
  auto *tracks = new QHBoxLayout(trackControls_);
  tracks->setContentsMargins(0, 0, 0, 0);
  audio_ = new QComboBox;
  audio_->setObjectName(QStringLiteral("SharedAudio"));
  subtitles_ = new QComboBox;
  subtitles_->setObjectName(QStringLiteral("SharedSubtitles"));
  for (auto *combo : {audio_, subtitles_}) {
    combo->setMinimumContentsLength(11);
    combo->setSizeAdjustPolicy(QComboBox::AdjustToMinimumContentsLengthWithIcon);
  }
  subtitleDelay_ = new QDoubleSpinBox;
  subtitleDelay_->setRange(-600, 600);
  subtitleDelay_->setDecimals(2);
  subtitleDelay_->setSingleStep(0.1);
  subtitleDelay_->setSuffix(tr(" s"));
  subtitleDelay_->setToolTip(tr("Shared subtitle delay"));
  subtitleDelay_->setMaximumWidth(95);
  chapters_ = new QComboBox;
  chapters_->setMinimumContentsLength(8);
  chapters_->setSizeAdjustPolicy(QComboBox::AdjustToMinimumContentsLengthWithIcon);
  auto *addSub = button(QString(), QStringLiteral("plus"));
  addSub->setToolTip(tr("Add a shared external subtitle file"));
  tracks->addWidget(audio_, 1);
  tracks->addWidget(subtitles_, 1);
  tracks->addWidget(addSub);
  tracks->addWidget(subtitleDelay_);
  tracks->addWidget(chapters_);
  playerLayout->addWidget(trackControls_);
  members_ = new QTableWidget(0, 3);
  members_->setObjectName(QStringLiteral("Watchers"));
  members_->setHorizontalHeaderLabels({tr("Member"), tr("Watch"), tr("Readiness")});
  tableStyle(members_);
  members_->setSelectionMode(QAbstractItemView::SingleSelection);
  members_->verticalHeader()->setDefaultSectionSize(28);
  members_->horizontalHeader()->setSectionResizeMode(0, QHeaderView::ResizeToContents);
  members_->horizontalHeader()->setSectionResizeMode(1, QHeaderView::ResizeToContents);
  members_->horizontalHeader()->setSectionResizeMode(2, QHeaderView::Stretch);
  members_->setMinimumHeight(82);
  members_->setMaximumHeight(145);
  members_->setContextMenuPolicy(Qt::CustomContextMenu);
  playerLayout->addWidget(members_);
  split_->addWidget(playerPanel);
  split_->setSizes({320, 800});
  layout->addWidget(split_, 1);
  connect(add, &QPushButton::clicked, this, [this] { emit addRequested(room_); });
  connect(manage, &QPushButton::clicked, this, [this] { emit manageRequested(room_); });
  connect(full, &QPushButton::clicked, this, &RoomPage::fullscreenRequested);
  connect(join_, &QPushButton::clicked, this,
          [this] { app_.perform([this] { app_.playback.joinWatch(); }); });
  connect(leave_, &QPushButton::clicked, this,
          [this] { app_.perform([this] { app_.playback.leaveWatch(); }); });
  connect(overlayAction_, &QPushButton::clicked, this, [this] {
    app_.perform([this] {
      if (overlayActionFn_) {
        overlayActionFn_();
        return;
      }
      if (!app_.playback.local() && !app_.playback.joined())
        app_.playback.joinWatch();
      else
        app_.playback.retry();
    });
  });
  connect(play_, &QPushButton::clicked, this,
          [this] { app_.perform([this] { app_.playback.togglePause(); }); });
  connect(next_, &QPushButton::clicked, this, [this] {
    app_.perform(
        [this] { app_.rooms.command(room_, {{QStringLiteral("type"), QStringLiteral("playback.next")}}); });
  });
  connect(queue_, &QTableView::doubleClicked, this, [this](const QModelIndex &index) {
    const auto id = queueProxy_.mapToSource(index).data(IdRole).toString();
    app_.perform([&] { app_.playback.choose(id); });
  });
  connect(history_, &QTableView::doubleClicked, this, [this] { rewatch(); });
  connect(queueTabs_, &QTabBar::currentChanged, this, [this](int index) {
    queueStack_->setCurrentIndex(index);
    loadHistory_->setVisible(index == 1 && loadedHistory_.size() >= 200);
    if (index == 1 && !room_.isEmpty())
      app_.rooms.history(room_, {}, historyQuery_);
  });
  connect(search, &QLineEdit::textChanged, this, [this](const QString &text) {
    historyQuery_ = text;
    queueProxy_.search(text);
    historyProxy_.setFilterFixedString(text);
    if (queueTabs_->currentIndex() == 1)
      historySearch_.start(250);
  });
  historySearch_.setSingleShot(true);
  connect(&historySearch_, &QTimer::timeout, this, [this] {
    if (!room_.isEmpty())
      app_.rooms.history(room_, {}, historyQuery_);
  });
  connect(up, &QPushButton::clicked, this, [this] { reorder(-1); });
  connect(down, &QPushButton::clicked, this, [this] { reorder(1); });
  connect(watched, &QPushButton::clicked, this, [this] { mark(true); });
  auto *unwatched = queueMenu->addAction(tr("Mark unwatched"));
  connect(unwatched, &QAction::triggered, this, [this] { mark(false); });
  auto *acquire = queueMenu->addAction(tr("Approve download on this device"));
  connect(acquire, &QAction::triggered, this, [this] {
    const auto ids = selectedEntries();
    app_.perform([&] {
      QHash<QString, QStringList> selected;
      for (const auto &id : ids) {
        const auto entry = app_.rooms.entry(room_, id);
        selected[entry.value(QStringLiteral("sourceId")).toString()].append(
            entry.value(QStringLiteral("mediaId")).toString());
      }
      for (auto it = selected.begin(); it != selected.end(); ++it)
        app_.media.approve(room_, it.key(), it.value());
    });
  });
  auto *watchAgain = queueMenu->addAction(tr("Watch again"));
  connect(watchAgain, &QAction::triggered, this, &RoomPage::rewatch);
  auto *rename = queueMenu->addAction(tr("Rename episode…"));
  connect(rename, &QAction::triggered, this, [this] {
    const auto id = selectedEntry();
    if (id.isEmpty())
      return;
    const auto original = app_.rooms.room(room_).value(QStringLiteral("queueRevision"));
    auto *dialog = new QInputDialog(this);
    dialog->setAttribute(Qt::WA_DeleteOnClose);
    dialog->setWindowTitle(tr("Rename episode"));
    dialog->setLabelText(tr("Room display name"));
    dialog->setTextValue(app_.rooms.entry(room_, id).value(QStringLiteral("label")).toString());
    connect(dialog, &QInputDialog::textValueSelected, this, [this, id, original](const QString &label) {
      app_.perform([&] {
        app_.rooms.command(room_,
                           {{QStringLiteral("type"), QStringLiteral("queue.rename")},
                            {QStringLiteral("entryId"), id},
                            {QStringLiteral("label"), label}},
                           {}, {{QStringLiteral("queueRevision"), original}});
      });
    });
    dialog->open();
  });
  auto *remove = queueMenu->addAction(tr("Remove from upcoming queue"));
  connect(remove, &QAction::triggered, this, [this] {
    const auto ids = selectedEntries();
    QJsonArray array;
    for (const auto &id : ids)
      array.append(id);
    if (!array.isEmpty())
      app_.perform([&] {
        app_.rooms.command(room_, {{QStringLiteral("type"), QStringLiteral("queue.remove")},
                                   {QStringLiteral("ids"), array}});
      });
  });
  connect(loadHistory_, &QPushButton::clicked, this, [this] {
    if (!loadedHistory_.isEmpty()) {
      loadHistory_->setEnabled(false);
      app_.rooms.history(room_, loadedHistory_.last().toObject(), historyQuery_);
    }
  });
  connect(&app_.rooms, &RoomClient::historyLoaded, this,
          [this](const QString &room, const QJsonArray &items, bool first) {
            if (room != room_)
              return;
            loadHistory_->setEnabled(true);
            if (first)
              loadedHistory_ = items;
            else {
              QSet<QString> seen;
              for (auto value : loadedHistory_)
                seen.insert(value.toObject().value(QStringLiteral("id")).toString());
              for (auto value : items)
                if (!seen.contains(value.toObject().value(QStringLiteral("id")).toString()))
                  loadedHistory_.append(value);
            }
            historyModel_.setRows(loadedHistory_);
            loadHistory_->setVisible(queueTabs_->currentIndex() == 1 && items.size() == 200);
          });
  connect(policy_, qOverload<int>(&QComboBox::activated), this, [this](int index) {
    app_.perform([&] { app_.media.setPolicy(room_, policy_->itemData(index).toString()); });
  });
  connect(seek_, &QSlider::sliderPressed, this, [this] {
    seeking_ = true;
    seekDuration_ = app_.playback.duration();
    seekGeneration_ = room_.isEmpty() ? -1
                                      : app_.rooms.room(room_)
                                            .value(QStringLiteral("playback"))
                                            .toObject()
                                            .value(QStringLiteral("generation"))
                                            .toInt();
  });
  connect(seek_, &QSlider::sliderReleased, this, [this] {
    seeking_ = false;
    const double seconds = double(seek_->value()) / 1000000 * seekDuration_;
    app_.perform([&] {
      if (app_.playback.local())
        app_.playback.seek(seconds);
      else
        app_.rooms.command(room_,
                           {{QStringLiteral("type"), QStringLiteral("playback.seek")},
                            {QStringLiteral("position"), seconds}},
                           {}, {{QStringLiteral("generation"), seekGeneration_}});
    });
  });
  connect(rate_, qOverload<int>(&QComboBox::activated), this, [this](int index) {
    app_.perform([&] { app_.playback.setRate(rate_->itemData(index).toDouble()); });
  });
  connect(volume_, &QSlider::valueChanged, &app_.player,
          [this](int volume) { app_.player.setVolume(volume); });
  connect(volume_, &QSlider::sliderReleased, this, [this] {
    app_.perform([this] { app_.store.setSetting(QStringLiteral("volume"), volume_->value()); });
  });
  connect(audio_, qOverload<int>(&QComboBox::activated), this, [this] { trackChoice(); });
  connect(subtitles_, qOverload<int>(&QComboBox::activated), this, [this] { trackChoice(); });
  connect(subtitleDelay_, &QDoubleSpinBox::editingFinished, this, &RoomPage::trackChoice);
  connect(chapters_, qOverload<int>(&QComboBox::activated), this, [this](int index) {
    if (chapters_->itemData(index).toDouble() >= 0)
      app_.perform([&] {
        if (app_.playback.entryId() != tracksEntry_)
          throw AppError(QStringLiteral("PLAYBACK_CHANGED"),
                         tr("The episode changed. Choose its chapter again."));
        if (app_.playback.local())
          app_.playback.seek(chapters_->itemData(index).toDouble());
        else
          app_.rooms.command(room_,
                             {{QStringLiteral("type"), QStringLiteral("playback.seek")},
                              {QStringLiteral("position"), chapters_->itemData(index).toDouble()}},
                             {}, {{QStringLiteral("generation"), tracksGeneration_}});
      });
  });
  connect(addSub, &QPushButton::clicked, this, [this] { emit subtitleRequested(room_); });
  connect(members_, &QWidget::customContextMenuRequested, this, [this](const QPoint &point) {
    if (room_.isEmpty() || !app_.rooms.connected(room_))
      return;
    const auto snapshot = app_.rooms.room(room_);
    if (snapshot.value(QStringLiteral("hostId")) !=
        app_.rooms.credential(room_).value(QStringLiteral("memberId")))
      return;
    auto *item = members_->itemAt(point);
    if (!item)
      return;
    const auto id = members_->item(item->row(), 0)->data(Qt::UserRole).toString();
    auto *menu = new QMenu(this);
    menu->setAttribute(Qt::WA_DeleteOnClose);
    auto *action = menu->addAction(tr("Continue without this watcher"));
    connect(action, &QAction::triggered, this, [this, id] {
      app_.perform([&] {
        app_.rooms.command(room_, {{QStringLiteral("type"), QStringLiteral("watch.exclude")},
                                   {QStringLiteral("memberId"), id}});
      });
    });
    menu->popup(members_->viewport()->mapToGlobal(point));
  });
  connect(video_, &VideoWidget::failure, this, [this](const QString &message) {
    app_.log(QStringLiteral("VIDEO_RENDERER"), message);
    emit app_.issue(QStringLiteral("VIDEO_RENDERER"), message);
  });
  connect(&app_.rooms, &RoomClient::queueChanged, this, [this](const QString &room) {
    if (room == room_)
      updateQueue();
  });
  connect(&app_.rooms, &RoomClient::changed, this, [this](const QString &room) {
    if (room == room_ && !refresh_.isActive())
      refresh_.start(100);
  });
  connect(&app_.rooms, &RoomClient::roomRemoved, this, [this](const QString &room) {
    if (room == room_) {
      room_.clear();
      loadedHistory_ = {};
      updateQueue();
      refresh();
    }
  });
  connect(&app_.rooms, &RoomClient::error, this,
          [this](const QString &room, const QString &, const QString &, const QString &) {
            if (room == room_)
              loadHistory_->setEnabled(true);
          });
  connect(&app_.playback, &PlaybackController::changed, this, [this] {
    if (!refresh_.isActive())
      refresh_.start(100);
  });
  refresh_.setSingleShot(true);
  connect(&refresh_, &QTimer::timeout, this, &RoomPage::refresh);
  refresh();
}
void RoomPage::setRoom(const QString &room) {
  if (room_ == room && !app_.playback.local())
    return;
  room_ = room;
  app_.perform([&] { app_.playback.setRoom(room); });
  loadedHistory_ = {};
  updateQueue();
  refresh();
}
void RoomPage::updateQueue() {
  if (room_.isEmpty()) {
    queueModel_.setRows({});
    historyModel_.setRows({});
    return;
  }
  const auto snapshot = app_.rooms.room(room_);
  const auto selected = selectedEntries();
  queueModel_.setRows(snapshot.value(QStringLiteral("entries")).toArray());
  for (const auto &id : selected) {
    const auto index = queueProxy_.mapFromSource(queueModel_.index(queueModel_.indexOf(id), 0));
    if (index.isValid())
      queue_->selectionModel()->select(index, QItemSelectionModel::Select | QItemSelectionModel::Rows);
  }
  QHash<QString, QJsonObject> items;
  for (auto value : loadedHistory_)
    items.insert(value.toObject().value(QStringLiteral("id")).toString(), value.toObject());
  for (auto value : snapshot.value(QStringLiteral("history")).toArray()) {
    const auto item = value.toObject();
    if (historyQuery_.isEmpty() ||
        item.value(QStringLiteral("label")).toString().contains(historyQuery_, Qt::CaseInsensitive))
      items.insert(item.value(QStringLiteral("id")).toString(), item);
  }
  QList<QJsonObject> ordered(items.begin(), items.end());
  std::sort(ordered.begin(), ordered.end(), [](const auto &a, const auto &b) {
    const auto at = a.value(QStringLiteral("watchedAt")).toInteger(),
               bt = b.value(QStringLiteral("watchedAt")).toInteger();
    return at != bt ? at > bt
                    : a.value(QStringLiteral("id")).toString() > b.value(QStringLiteral("id")).toString();
  });
  loadedHistory_ = {};
  for (const auto &item : ordered)
    loadedHistory_.append(item);
  historyModel_.setRows(loadedHistory_);
}
QString RoomPage::selectedEntry() const {
  if (queueTabs_->currentIndex() == 1)
    return historyModel_.row(historyProxy_.mapToSource(history_->currentIndex()).row())
        .value(QStringLiteral("entryId"))
        .toString();
  return queueProxy_.mapToSource(queue_->currentIndex()).data(IdRole).toString();
}
QStringList RoomPage::selectedEntries() const {
  QStringList ids;
  if (queueTabs_->currentIndex() == 1) {
    for (auto index : history_->selectionModel()->selectedRows())
      ids.append(historyModel_.row(historyProxy_.mapToSource(index).row())
                     .value(QStringLiteral("entryId"))
                     .toString());
  } else
    for (auto index : queue_->selectionModel()->selectedRows())
      ids.append(queueProxy_.mapToSource(index).data(IdRole).toString());
  return ids;
}
void RoomPage::mark(bool watched) {
  const auto selected = selectedEntries();
  if (selected.isEmpty())
    return;
  QJsonArray ids;
  for (const auto &id : selected)
    ids.append(id);
  app_.perform([&] {
    app_.rooms.command(room_, {{QStringLiteral("type"), QStringLiteral("history.mark")},
                               {QStringLiteral("ids"), ids},
                               {QStringLiteral("watched"), watched}});
  });
}
void RoomPage::rewatch() {
  auto entry = selectedEntry();
  if (queueTabs_->currentIndex() == 1 && app_.rooms.entry(room_, entry).isEmpty()) {
    const auto historical = historyModel_.row(historyProxy_.mapToSource(history_->currentIndex()).row());
    for (auto value : app_.rooms.room(room_).value(QStringLiteral("entries")).toArray()) {
      const auto item = value.toObject();
      if (item.value(QStringLiteral("mediaId")) == historical.value(QStringLiteral("mediaId"))) {
        entry = item.value(QStringLiteral("id")).toString();
        break;
      }
    }
    if (app_.rooms.entry(room_, entry).isEmpty()) {
      emit app_.issue(
          QStringLiteral("SOURCE_REMOVED"),
          tr("Add the matching source again to rewatch this episode. Its room history is retained."));
      return;
    }
  }
  if (!entry.isEmpty())
    app_.perform([&] {
      app_.rooms.command(room_, {{QStringLiteral("type"), QStringLiteral("history.rewatch")},
                                 {QStringLiteral("entryId"), entry}});
    });
}
void RoomPage::reorder(int direction) {
  if (room_.isEmpty() || queueTabs_->currentIndex() != 0)
    return;
  const auto id = selectedEntry();
  if (id.isEmpty())
    return;
  const auto snapshot = app_.rooms.room(room_);
  QStringList order;
  for (auto value : snapshot.value(QStringLiteral("entries")).toArray()) {
    const auto e = value.toObject();
    if (e.value(QStringLiteral("enabled")).toBool() && !e.value(QStringLiteral("watchedAt")).isDouble())
      order.append(e.value(QStringLiteral("id")).toString());
  }
  const int at = order.indexOf(id);
  if (at < 0 || at + direction < 0 || at + direction >= order.size())
    return;
  order.swapItemsAt(at, at + direction);
  QJsonArray ids;
  for (const auto &entry : order)
    ids.append(entry);
  app_.perform([&] {
    app_.rooms.command(
        room_, {{QStringLiteral("type"), QStringLiteral("queue.reorder")}, {QStringLiteral("ids"), ids}});
  });
}
void RoomPage::trackChoice() {
  if (audio_->currentIndex() < 0 || subtitles_->currentIndex() < 0)
    return;
  app_.perform([this] {
    if (app_.playback.local()) {
      if (tracksEntry_ != app_.playback.entryId())
        throw AppError(QStringLiteral("MEDIA_CHANGED"),
                       tr("The video changed while choosing tracks. Choose again."));
      app_.playback.setTracks(audio_->currentData().toString(), subtitles_->currentData().toString(),
                              subtitleDelay_->value());
    } else
      app_.rooms.command(room_,
                         {{QStringLiteral("type"), QStringLiteral("tracks.select")},
                          {QStringLiteral("audio"), audio_->currentData().toString()},
                          {QStringLiteral("subtitle"), subtitles_->currentData().toString()},
                          {QStringLiteral("subtitleDelay"), subtitleDelay_->value()}},
                         {}, {{QStringLiteral("generation"), tracksGeneration_}});
  });
}
void RoomPage::updateTracks() {
  if (audio_->view()->isVisible() || subtitles_->view()->isVisible() || chapters_->view()->isVisible() ||
      subtitleDelay_->hasFocus())
    return;
  const auto snapshot = room_.isEmpty() ? QJsonObject() : app_.rooms.room(room_);
  const auto p = snapshot.value(QStringLiteral("playback")).toObject();
  QJsonArray statusTracks;
  for (auto value : snapshot.value(QStringLiteral("members")).toArray()) {
    const auto m = value.toObject(), status = m.value(QStringLiteral("status")).toObject();
    statusTracks.append(QJsonObject{{QStringLiteral("watch"), m.value(QStringLiteral("watch"))},
                                    {QStringLiteral("audio"), status.value(QStringLiteral("audio"))},
                                    {QStringLiteral("subtitles"), status.value(QStringLiteral("subtitles"))},
                                    {QStringLiteral("entryId"), status.value(QStringLiteral("entryId"))},
                                    {QStringLiteral("known"), status.value(QStringLiteral("tracksKnown"))}});
  }
  const auto signature =
      QJsonDocument(
          QJsonObject{{QStringLiteral("generation"), p.value(QStringLiteral("generation"))},
                      {QStringLiteral("queueRevision"), snapshot.value(QStringLiteral("queueRevision"))},
                      {QStringLiteral("tracks"), app_.player.tracks()},
                      {QStringLiteral("chapters"), app_.player.chapters()},
                      {QStringLiteral("audio"), app_.playback.audioChoice()},
                      {QStringLiteral("subtitle"), app_.playback.subtitleChoice()},
                      {QStringLiteral("delay"), app_.playback.subtitleDelay()},
                      {QStringLiteral("local"), app_.playback.local()},
                      {QStringLiteral("members"), statusTracks}})
          .toJson(QJsonDocument::Compact);
  if (signature == trackSignature_)
    return;
  trackSignature_ = signature;
  tracksGeneration_ = p.value(QStringLiteral("generation")).toInt();
  tracksEntry_ = app_.playback.entryId();
  const QSignalBlocker a(audio_), s(subtitles_), d(subtitleDelay_), c(chapters_);
  audio_->clear();
  subtitles_->clear();
  audio_->addItem(tr("Default audio"), QStringLiteral("auto"));
  subtitles_->addItem(tr("Subtitles off"), QStringLiteral("off"));
  QHash<QString, QString> labels;
  if (app_.player.loaded())
    for (auto value : app_.player.tracks()) {
      const auto t = value.toObject();
      labels.insert(t.value(QStringLiteral("key")).toString(), trackLabel(t));
    }
  QSet<QString> audio, subtitles;
  QList<QJsonObject> watchers;
  for (auto it = labels.begin(); it != labels.end(); ++it) {
    if (it.key().startsWith(QStringLiteral("audio:")))
      audio.insert(it.key());
    else
      subtitles.insert(it.key());
  }
  for (auto value : snapshot.value(QStringLiteral("members")).toArray()) {
    if (app_.playback.local())
      break;
    const auto m = value.toObject();
    const auto watch = m.value(QStringLiteral("watch")).toString();
    if (watch != QStringLiteral("active") && watch != QStringLiteral("staging"))
      continue;
    const auto status = m.value(QStringLiteral("status")).toObject();
    if (status.value(QStringLiteral("tracksKnown")).toBool() &&
        status.value(QStringLiteral("entryId")) == p.value(QStringLiteral("entryId")))
      watchers.append(m);
    for (auto key : status.value(QStringLiteral("audio")).toArray())
      audio.insert(key.toString());
    for (auto key : status.value(QStringLiteral("subtitles")).toArray())
      subtitles.insert(key.toString());
  }
  auto fill = [&](QComboBox *combo, const QSet<QString> &keys) {
    QStringList ordered(keys.begin(), keys.end());
    std::sort(ordered.begin(), ordered.end());
    for (const auto &key : ordered) {
      combo->addItem(labels.value(key, key.startsWith(QStringLiteral("audio:"))
                                           ? tr("Audio %1").arg(key.section(QLatin1Char(':'), -1))
                                           : tr("Subtitle %1").arg(key.section(QLatin1Char(':'), -1))),
                     key);
      QStringList missing;
      if (!key.startsWith(QStringLiteral("ext:")))
        for (const auto &member : watchers) {
          const auto choices =
              member.value(QStringLiteral("status"))
                  .toObject()
                  .value(key.startsWith(QStringLiteral("audio:")) ? QStringLiteral("audio")
                                                                  : QStringLiteral("subtitles"))
                  .toArray();
          if (!choices.contains(key))
            missing.append(member.value(QStringLiteral("name")).toString());
        }
      if (!missing.isEmpty()) {
        auto *item = qobject_cast<QStandardItemModel *>(combo->model())->item(combo->count() - 1);
        item->setEnabled(false);
        item->setText(item->text() + tr(" · unavailable for %1").arg(missing.join(QStringLiteral(", "))));
        item->setToolTip(tr("Choose a track available to every joined watcher."));
      }
    }
  };
  if (!app_.playback.local() && !room_.isEmpty()) {
    const auto episode = app_.rooms.entry(room_, p.value(QStringLiteral("entryId")).toString());
    const auto stem = QFileInfo(episode.value(QStringLiteral("path")).toString()).completeBaseName();
    for (auto source : snapshot.value(QStringLiteral("sources")).toArray())
      for (auto value : source.toObject().value(QStringLiteral("assets")).toArray()) {
        const auto asset = value.toObject();
        const auto key = QStringLiteral("ext:") + asset.value(QStringLiteral("sha256")).toString();
        const auto path = asset.value(QStringLiteral("path")).toString();
        if (asset.value(QStringLiteral("kind")).toString() == QStringLiteral("subtitle") &&
            ((!stem.isEmpty() && QFileInfo(path).completeBaseName().startsWith(stem, Qt::CaseInsensitive)) ||
             p.value(QStringLiteral("subtitle")).toString() == key ||
             source.toObject().value(QStringLiteral("assets")).toArray().size() == 1)) {
          subtitles.insert(key);
          labels.insert(key, tr("Shared · %1").arg(QFileInfo(path).fileName()));
        }
      }
  }
  fill(audio_, audio);
  fill(subtitles_, subtitles);
  const auto currentAudio = app_.playback.audioChoice(), currentSub = app_.playback.subtitleChoice();
  if (audio_->findData(currentAudio) < 0 && !currentAudio.isEmpty())
    audio_->addItem(tr("Unavailable · %1").arg(currentAudio), currentAudio);
  if (subtitles_->findData(currentSub) < 0 && !currentSub.isEmpty())
    subtitles_->addItem(tr("Unavailable · %1").arg(currentSub), currentSub);
  audio_->setCurrentIndex(std::max(0, audio_->findData(currentAudio)));
  subtitles_->setCurrentIndex(std::max(0, subtitles_->findData(currentSub)));
  subtitleDelay_->setValue(app_.playback.subtitleDelay());
  if (!chapters_->view()->isVisible()) {
    chapters_->clear();
    chapters_->addItem(tr("Chapters"), -1);
    if (app_.player.loaded())
      for (auto value : app_.player.chapters()) {
        const auto chapter = value.toObject();
        chapters_->addItem(
            chapter.value(QStringLiteral("title")).toString(tr("Chapter %1").arg(chapters_->count())),
            chapter.value(QStringLiteral("time")).toDouble());
      }
  }
}
void RoomPage::refresh() {
  app_.perform([this] {
    const bool local = app_.playback.local(), connected = !room_.isEmpty() && app_.rooms.connected(room_);
    const auto snapshot = room_.isEmpty() ? QJsonObject() : app_.rooms.room(room_);
    const auto p = snapshot.value(QStringLiteral("playback")).toObject();
    roomTitle_->setText(local ? tr("Local preview")
                              : snapshot.value(QStringLiteral("name")).toString(tr("Your room")));
    roomSubtitle_->setText(
        local             ? tr("This preview plays only on your device. Join watch to return to the room.")
        : connected       ? tr("Persistent room · Everyone can edit the queue and control playback")
        : room_.isEmpty() ? tr("Create or join a room to watch together.")
                          : app_.rooms.connectionState(room_));
    policy_->setEnabled(connected);
    if (!room_.isEmpty()) {
      const QSignalBlocker blocker(policy_);
      policy_->setCurrentIndex(std::max(0, policy_->findData(app_.media.policy(room_))));
    }
    episodeTitle_->setText(app_.playback.title().isEmpty() ? tr("Choose an episode") : app_.playback.title());
    queueModel_.setCurrent(p.value(QStringLiteral("entryId")).toString());
    historyModel_.setCurrent(room_.isEmpty()
                                 ? QString()
                                 : app_.rooms.entry(room_, p.value(QStringLiteral("entryId")).toString())
                                       .value(QStringLiteral("viewingId"))
                                       .toString());
    historyModel_.refreshAges();
    join_->setVisible(!app_.playback.joined() || local);
    leave_->setVisible(app_.playback.joined() && !local);
    join_->setEnabled(connected);
    join_->setText(local ? tr("Return to room") : tr("Join watch"));
    play_->setEnabled(local || connected);
    next_->setEnabled(!local && connected);
    play_->setIcon(icon(app_.playback.playRequested() ? QStringLiteral("pause") : QStringLiteral("play")));
    play_->setToolTip(local                           ? tr("Play or pause this local preview")
                      : app_.playback.playRequested() ? tr("Pause the room, including automatic resume")
                                                      : tr("Play for the room"));
    const double duration = app_.playback.duration(), position = app_.playback.position();
    time_->setText(elapsed(position) + QStringLiteral(" / ") +
                   (duration > 0 ? elapsed(duration) : QStringLiteral("—")));
    seek_->setEnabled((local || connected) && duration > 0);
    if (!seeking_) {
      const QSignalBlocker blocker(seek_);
      seek_->setValue(duration > 0 ? int(std::clamp(position / duration, 0.0, 1.0) * 1000000) : 0);
    }
    {
      const QSignalBlocker blocker(rate_);
      const int index = rate_->findData(app_.playback.rate());
      if (index >= 0)
        rate_->setCurrentIndex(index);
    }
    if (!volume_->isSliderDown()) {
      const QSignalBlocker blocker(volume_);
      volume_->setValue(int(app_.player.volume()));
    }
    const auto localReason = app_.playback.reason();
    const auto sharedReason = p.value(QStringLiteral("reason")).toString();
    state_->setText(!localReason.isEmpty()                                     ? localReason
                    : !local && p.value(QStringLiteral("paused")).toBool(true) ? sharedReason
                                                                               : tr("Playing"));
    state_->setToolTip(state_->text());
    const bool blocking =
        !app_.player.loaded() || (!local && !app_.playback.joined()) || !localReason.isEmpty();
    overlay_->setVisible(blocking);
    overlayText_->setText(localReason.isEmpty() ? tr("Join the watch when you are ready.") : localReason);
    overlayAction_->setText(!local && !app_.playback.joined() ? tr("Join watch") : tr("Retry playback"));
    overlayAction_->setEnabled(local || connected);
    overlayAction_->setVisible(!app_.player.loaded() || !localReason.isEmpty());
    overlayActionFn_ = {};
    if (!local && !connected) {
      overlayAction_->setText(tr("Room options"));
      overlayAction_->setEnabled(!room_.isEmpty());
      overlayActionFn_ = [this] {
        emit manageRequested(room_);
      };
    } else if (!local && app_.playback.joined() && !p.value(QStringLiteral("entryId")).toString().isEmpty() &&
               !localReason.isEmpty()) {
      const auto id = p.value(QStringLiteral("entryId")).toString();
      const auto binding = app_.media.binding(room_, id);
      const auto entry = app_.rooms.entry(room_, id);
      const auto sourceId = entry.value(QStringLiteral("sourceId")).toString();
      if (!binding.transferId.isEmpty()) {
        overlayAction_->setText(tr("View transfer / choose files"));
        overlayActionFn_ = [this, transfer = binding.transferId] {
          emit transferRequested(transfer);
        };
      } else {
        const auto sharedId = QStringLiteral("sha256:") + entry.value(QStringLiteral("sha256")).toString();
        for (auto value : app_.sharing.downloads())
          if (value.toObject().value(QStringLiteral("id")).toString() == sharedId) {
            overlayAction_->setText(tr("View shared download"));
            overlayActionFn_ = [this, sharedId] {
              emit transferRequested(sharedId);
            };
            const auto row = value.toObject();
            overlayText_->setText(localReason + QStringLiteral("\n") +
                                  tr("%1 of %2 verified · %3")
                                      .arg(bytes(row.value(QStringLiteral("received")).toInteger()),
                                           bytes(row.value(QStringLiteral("total")).toInteger()),
                                           row.value(QStringLiteral("transport")).toString()));
            break;
          }
        const auto source =
            app_.store.get(QStringLiteral("room-source"), room_ + QLatin1Char(':') + sourceId);
        const auto download = source.value(QStringLiteral("download")).toString();
        if (!download.isEmpty()) {
          const auto state = app_.direct.download(download).value(QStringLiteral("state")).toString();
          if (state == QStringLiteral("Paused") || state == QStringLiteral("Error")) {
            overlayAction_->setText(tr("Resume / retry download"));
            overlayActionFn_ = [this, download] {
              app_.direct.resume(download);
            };
          }
        }
        if (!overlayActionFn_ && !binding.source) {
          overlayAction_->setText(tr("Download this episode"));
          overlayActionFn_ = [this, sourceId, media = entry.value(QStringLiteral("mediaId")).toString()] {
            app_.media.approve(room_, sourceId, {media});
          };
        }
      }
    }
    const auto members = snapshot.value(QStringLiteral("members")).toArray();
    if (members_->rowCount() != members.size())
      members_->setRowCount(members.size());
    for (int row = 0; row < members.size(); ++row) {
      const auto member = members[row].toObject(), status = member.value(QStringLiteral("status")).toObject();
      const auto watch = member.value(QStringLiteral("watch")).toString();
      const bool online = member.value(QStringLiteral("connected")).toBool();
      const auto memberReason = status.value(QStringLiteral("reason")).toString();
      const QStringList fields{member.value(QStringLiteral("name")).toString(),
                               watch == QStringLiteral("active")     ? tr("Watching")
                               : watch == QStringLiteral("staging")  ? tr("Preparing")
                               : watch == QStringLiteral("excluded") ? tr("Continued without")
                                                                     : tr("In room"),
                               !online ? tr("Disconnected")
                               : watch == QStringLiteral("idle") || watch == QStringLiteral("excluded")
                                   ? tr("Not blocking playback")
                               : status.value(QStringLiteral("ready")).toBool() &&
                                       status.value(QStringLiteral("generation")) ==
                                           p.value(QStringLiteral("generation"))
                                   ? tr("Ready")
                               : memberReason.isEmpty() ? tr("Synchronizing readiness…")
                                                        : memberReason};
      for (int col = 0; col < 3; ++col) {
        auto *item = members_->item(row, col);
        if (!item) {
          item = new QTableWidgetItem;
          members_->setItem(row, col, item);
        }
        item->setText(fields[col]);
        item->setToolTip(fields[col]);
        if (col == 0)
          item->setData(Qt::UserRole, member.value(QStringLiteral("id")).toString());
      }
    }
    audio_->setEnabled(local || connected);
    subtitles_->setEnabled(local || connected);
    subtitleDelay_->setEnabled(local || connected);
    updateTracks();
  });
}
void RoomPage::fullscreen(bool enabled) {
  fullscreen_ = enabled;
  header_->setVisible(!enabled);
  queuePanel_->setVisible(!enabled);
  trackControls_->setVisible(!enabled);
  members_->setVisible(!enabled);
}
} // namespace wp::ui
