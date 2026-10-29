#include "window.h"
#include <QCloseEvent>
#include <QEventLoop>
#include <QFileDialog>
#include <QHBoxLayout>
#include <QHeaderView>
#include <QListWidget>
#include <QMessageBox>
#include <QPushButton>
#include <QRegularExpression>
#include <QSplitter>
#include <QTabWidget>
#include <QToolBar>
#include <QVBoxLayout>
#include <algorithm>

namespace wp {
static bool isVideo(const QString &path) {
  static const QRegularExpression re(QStringLiteral("\\.(mkv|mp4|webm|avi|mov|m4v|ts)$"),
                                     QRegularExpression::CaseInsensitiveOption);
  return re.match(path).hasMatch();
}
Window::Window(const QString &profile, bool localOnly)
    : torrent_(std::make_unique<TorrentService>(profile, nullptr, localOnly)),
      stream_(std::make_unique<VerifiedStream>(*torrent_)),
      player_(std::make_unique<Player>(nullptr, false, localOnly)) {
  setWindowTitle(QStringLiteral("WatchPair v2 · Native integration prototype"));
  resize(1240, 820);
  auto *tools = addToolBar(QStringLiteral("Transfers"));
  tools->setMovable(false);
  auto *open = tools->addAction(QStringLiteral("Add torrent…"));
  connect(open, &QAction::triggered, this, [this] {
    auto source = QFileDialog::getOpenFileName(this, QStringLiteral("Choose torrent"), {},
                                               QStringLiteral("Torrent files (*.torrent)"));
    if (source.isEmpty())
      return;
    auto destination = QFileDialog::getExistingDirectory(this, QStringLiteral("Choose download location"));
    if (!destination.isEmpty())
      add(source, destination);
  });
  auto *pause = tools->addAction(QStringLiteral("Pause transfer"));
  connect(pause, &QAction::triggered, this, [this] {
    try {
      if (torrent_->valid())
        torrent_->pause();
    } catch (const std::exception &e) {
      log(QString::fromUtf8(e.what()));
    }
  });
  auto *resume = tools->addAction(QStringLiteral("Resume transfer"));
  connect(resume, &QAction::triggered, this, [this] {
    try {
      if (torrent_->valid())
        torrent_->resume();
    } catch (const std::exception &e) {
      log(QString::fromUtf8(e.what()));
    }
  });
  auto *split = new QSplitter;
  auto *nav = new QListWidget;
  nav->addItems({QStringLiteral("Transfers"), QStringLiteral("Prototype diagnostics")});
  nav->setMaximumWidth(185);
  nav->setCurrentRow(0);
  split->addWidget(nav);
  auto *body = new QSplitter(Qt::Vertical);
  transfers_ = new QTableWidget(1, 5);
  transfers_->setHorizontalHeaderLabels({QStringLiteral("Torrent"), QStringLiteral("Transfer state"),
                                         QStringLiteral("Downloaded"), QStringLiteral("Peers"),
                                         QStringLiteral("Verified bytes served")});
  transfers_->horizontalHeader()->setSectionResizeMode(QHeaderView::Stretch);
  transfers_->setEditTriggers(QAbstractItemView::NoEditTriggers);
  transfers_->verticalHeader()->hide();
  body->addWidget(transfers_);
  auto *playback = new QWidget;
  auto *playLayout = new QVBoxLayout(playback);
  video_ = new VideoWidget(*player_);
  playLayout->addWidget(video_, 1);
  auto *controls = new QHBoxLayout;
  auto *play = new QPushButton(QStringLiteral("Play selected episode"));
  connect(play, &QPushButton::clicked, this, &Window::playSelected);
  controls->addWidget(play);
  auto *toggle = new QPushButton(QStringLiteral("Play / pause"));
  connect(toggle, &QPushButton::clicked, this, [this] {
    playerPaused_ = !playerPaused_;
    player_->setPaused(playerPaused_);
  });
  controls->addWidget(toggle);
  seek_ = new QSlider(Qt::Horizontal);
  seek_->setRange(0, 1000);
  connect(seek_, &QSlider::sliderReleased, this,
          [this] { player_->seek(player_->duration() * seek_->value() / 1000); });
  controls->addWidget(seek_, 1);
  playLayout->addLayout(controls);
  status_ =
      new QLabel(QStringLiteral("Native integration only · Room synchronization and relay are later gates"));
  status_->setWordWrap(true);
  playLayout->addWidget(status_);
  body->addWidget(playback);
  auto *tabs = new QTabWidget;
  auto *content = new QWidget;
  auto *contentLayout = new QVBoxLayout(content);
  files_ = new QTreeWidget;
  files_->setHeaderLabels({QStringLiteral("Content / original manifest index"), QStringLiteral("Size")});
  files_->header()->setSectionResizeMode(0, QHeaderView::Stretch);
  contentLayout->addWidget(files_);
  auto *apply = new QPushButton(QStringLiteral("Apply download selection"));
  connect(apply, &QPushButton::clicked, this, &Window::applySelection);
  contentLayout->addWidget(apply);
  tabs->addTab(content, QStringLiteral("Content"));
  activity_ = new QPlainTextEdit;
  activity_->setReadOnly(true);
  activity_->setMaximumBlockCount(500);
  tabs->addTab(activity_, QStringLiteral("Activity"));
  body->addWidget(tabs);
  body->setSizes({70, 460, 220});
  split->addWidget(body);
  split->setStretchFactor(1, 1);
  setCentralWidget(split);
  connect(nav, &QListWidget::currentRowChanged, this,
          [tabs](int row) { tabs->setCurrentIndex(row ? 1 : 0); });
  connect(torrent_.get(), &TorrentService::manifestChanged, this, &Window::fillManifest);
  connect(torrent_.get(), &TorrentService::activity, this, &Window::log);
  connect(player_.get(), &Player::activity, this, &Window::log);
  connect(stream_.get(), &VerifiedStream::failure, this, &Window::log);
  connect(video_, &VideoWidget::failure, this, &Window::log);
  connect(&refresh_, &QTimer::timeout, this, &Window::refresh);
  refresh_.start(250);
  setStyleSheet(
      QStringLiteral("QWidget{background:#171b22;color:#e5e9ef;font-size:13px;} "
                     "QToolBar,QTabBar::tab{background:#242b35;padding:7px;} "
                     "QPushButton{background:#303c4d;border:1px solid #536273;padding:7px;} "
                     "QTreeWidget,QTableWidget,QPlainTextEdit,QListWidget{background:#10151b;alternate-"
                     "background-color:#202832;} QHeaderView::section{background:#293343;padding:7px;} "
                     "QSplitter::handle{background:#343f4b;}"));
  try {
    torrent_->restore();
  } catch (const std::exception &e) {
    log(QString::fromUtf8(e.what()));
  }
}
Window::~Window() {
  refresh_.stop();
  delete video_;
  video_ = nullptr;
  player_.reset();
  stream_.reset();
  torrent_.reset();
}
void Window::add(const QString &source, const QString &destination) {
  try {
    torrent_->add(source, destination);
    fillManifest();
  } catch (const std::exception &e) {
    QMessageBox::warning(this, QStringLiteral("Cannot add torrent"), QString::fromUtf8(e.what()));
  }
}
void Window::fillManifest() {
  files_->clear();
  QHash<QString, QTreeWidgetItem *> folders;
  for (const auto &f : torrent_->files()) {
    const auto parts = f.path.split(QLatin1Char('/'));
    QString path;
    QTreeWidgetItem *parent = nullptr;
    for (int i = 0; i < parts.size() - 1; ++i) {
      path += parts[i] + QLatin1Char('/');
      if (!folders.contains(path)) {
        auto *folder = parent ? new QTreeWidgetItem(parent) : new QTreeWidgetItem(files_);
        folder->setText(0, parts[i]);
        folder->setFlags(folder->flags() | Qt::ItemIsAutoTristate | Qt::ItemIsUserCheckable);
        folder->setCheckState(0, Qt::Unchecked);
        folders.insert(path, folder);
      }
      parent = folders[path];
    }
    auto *leaf = parent ? new QTreeWidgetItem(parent) : new QTreeWidgetItem(files_);
    leaf->setText(0, QStringLiteral("%1  [#%2]").arg(parts.last()).arg(f.index));
    leaf->setText(1, QStringLiteral("%1 MiB").arg(f.size / (1024.0 * 1024.0), 0, 'f', 2));
    leaf->setData(0, Qt::UserRole, f.index);
    leaf->setFlags(leaf->flags() | Qt::ItemIsUserCheckable);
    leaf->setCheckState(0, torrent_->selected(f.index) ? Qt::Checked : Qt::Unchecked);
  }
  files_->expandToDepth(1);
}
void Window::applySelection() {
  QList<int> indexes;
  QTreeWidgetItemIterator it(files_);
  while (*it) {
    auto *item = *it;
    if (item->data(0, Qt::UserRole).isValid() && item->checkState(0) == Qt::Checked)
      indexes.append(item->data(0, Qt::UserRole).toInt());
    ++it;
  }
  try {
    torrent_->select(indexes);
    if (playingFile_ >= 0 && !indexes.contains(playingFile_)) {
      player_->stop();
      playingFile_ = -1;
    }
    log(QStringLiteral("Explicit selection applied: %1 files").arg(indexes.size()));
  } catch (const std::exception &e) {
    log(QString::fromUtf8(e.what()));
  }
}
void Window::playSelected() {
  auto *item = files_->currentItem();
  if (!item || !item->data(0, Qt::UserRole).isValid()) {
    log(QStringLiteral("Select an episode row in Content"));
    return;
  }
  if (item->checkState(0) != Qt::Checked) {
    log(QStringLiteral("Check this file and apply the download selection first"));
    return;
  }
  playingFile_ = item->data(0, Qt::UserRole).toInt();
  const auto files = torrent_->files();
  auto file =
      std::find_if(files.cbegin(), files.cend(), [this](const auto &f) { return f.index == playingFile_; });
  if (file == files.cend() || !isVideo(file->path)) {
    log(QStringLiteral("This manifest entry is not a supported video"));
    return;
  }
  applySelection();
  player_->open(stream_->url(playingFile_));
  player_->setPaused(false);
  playerPaused_ = false;
}
void Window::selectVideosAndPlay() {
  int first = -1;
  for (const auto &file : torrent_->files())
    if (isVideo(file.path)) {
      first = file.index;
      break;
    }
  QTreeWidgetItemIterator it(files_);
  while (*it) {
    auto *item = *it;
    if (item->data(0, Qt::UserRole).isValid() && item->data(0, Qt::UserRole).toInt() == first) {
      item->setCheckState(0, Qt::Checked);
      files_->setCurrentItem(item);
      break;
    }
    ++it;
  }
  playSelected();
}
void Window::refresh() {
  auto cell = [this](int col, const QString &value) {
    if (!transfers_->item(0, col))
      transfers_->setItem(0, col, new QTableWidgetItem);
    transfers_->item(0, col)->setText(value);
  };
  cell(0, torrent_->label());
  cell(1, torrent_->paused()                ? QStringLiteral("Paused manually")
          : !torrent_->valid()              ? QStringLiteral("No transfer")
          : torrent_->files().isEmpty()     ? QStringLiteral("Getting metadata")
          : torrent_->selection().isEmpty() ? QStringLiteral("Waiting for file selection")
          : torrent_->progress() >= 1       ? QStringLiteral("Downloaded")
          : torrent_->peers()               ? QStringLiteral("Downloading")
                                            : QStringLiteral("Waiting for peers"));
  cell(2, QStringLiteral("%1%").arg(torrent_->progress() * 100, 0, 'f', 1));
  cell(3, QString::number(torrent_->peers()));
  cell(4, QStringLiteral("%1 KiB").arg(stream_->servedBytes() / 1024));
  if (!seek_->isSliderDown() && player_->duration() > 0)
    seek_->setValue(static_cast<int>(1000 * player_->position() / player_->duration()));
  status_->setText(
      QStringLiteral("%1 / %2 s · %3 · piece cache %4 KiB · %5 reader requests · Prototype: no room "
                     "synchronization yet%6")
          .arg(player_->position(), 0, 'f', 1)
          .arg(player_->duration(), 0, 'f', 1)
          .arg(player_->buffering() ? QStringLiteral("Buffering verified data")
               : player_->loaded()  ? QStringLiteral("Native playback")
                                    : QStringLiteral("Waiting for media"))
          .arg(stream_->cacheBytes() / 1024)
          .arg(stream_->activeRequests())
          .arg(player_->error().isEmpty() ? QString() : QStringLiteral(" · ERROR: ") + player_->error()));
}
void Window::log(const QString &message) {
  activity_->appendPlainText(message);
  qInfo().noquote() << message;
}
void Window::closeEvent(QCloseEvent *event) {
  torrent_->checkpoint();
  QEventLoop loop;
  QTimer::singleShot(500, &loop, &QEventLoop::quit);
  loop.exec();
  event->accept();
}
} // namespace wp
