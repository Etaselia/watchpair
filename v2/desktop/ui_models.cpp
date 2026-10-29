#include "ui_models.h"
#include <QApplication>
#include <QBrush>
#include <QCollator>
#include <QComboBox>
#include <QDateTime>
#include <QFileInfo>
#include <QFont>
#include <QLocale>
#include <QPainter>
#include <QStyle>
#include <algorithm>
#include <cmath>
namespace wp::ui {
namespace {
QStringList transferHeaders() {
  return {QStringLiteral("#"),        QStringLiteral("Name"),   QStringLiteral("Size"),
          QStringLiteral("Progress"), QStringLiteral("Status"), QStringLiteral("Seeds"),
          QStringLiteral("Peers"),    QStringLiteral("Down"),   QStringLiteral("Up"),
          QStringLiteral("ETA"),      QStringLiteral("Ratio"),  QStringLiteral("Location")};
}
QString priority(int p) {
  if (p < 0)
    return QStringLiteral("Mixed");
  if (!p)
    return QStringLiteral("Do not download");
  if (p < 4)
    return QStringLiteral("Low");
  if (p < 6)
    return QStringLiteral("Normal");
  if (p < 7)
    return QStringLiteral("High");
  return QStringLiteral("Maximum");
}
QColor stateColor(const QString &state) {
  if (state == QStringLiteral("Error") || state == QStringLiteral("Missing"))
    return QColor(QStringLiteral("#fb8a9b"));
  if (state == QStringLiteral("Seeding") || state == QStringLiteral("Ready") ||
      state == QStringLiteral("Available"))
    return QColor(QStringLiteral("#71d6ba"));
  if (state == QStringLiteral("Downloading"))
    return QColor(QStringLiteral("#8fb7ff"));
  if (state == QStringLiteral("Waiting") || state == QStringLiteral("Stalled"))
    return QColor(QStringLiteral("#e9bd7c"));
  return QColor(QStringLiteral("#a1afc3"));
}
QStringList headers(JsonKind kind) {
  switch (kind) {
  case JsonKind::Queue:
    return {QStringLiteral("Episode"), QStringLiteral("Queue"), QStringLiteral("Length"),
            QStringLiteral("Folder")};
  case JsonKind::History:
    return {QStringLiteral("Episode"), QStringLiteral("Watched"), QStringLiteral("Coverage"),
            QStringLiteral("Recorded")};
  case JsonKind::Library:
    return {QStringLiteral("Name"), QStringLiteral("Folder"), QStringLiteral("Size"),
            QStringLiteral("Status")};
  case JsonKind::Peers:
    return {QStringLiteral("Address"), QStringLiteral("Client"), QStringLiteral("Progress"),
            QStringLiteral("Down"), QStringLiteral("Up")};
  case JsonKind::Trackers:
    return {QStringLiteral("Tracker"), QStringLiteral("Tier"), QStringLiteral("Status")};
  case JsonKind::Downloads:
    return {QStringLiteral("Name"),   QStringLiteral("Type"), QStringLiteral("Progress"),
            QStringLiteral("Status"), QStringLiteral("Down"), QStringLiteral("Size"),
            QStringLiteral("Queue")};
  }
  return {};
}
} // namespace
QString bytes(qint64 value) {
  if (value < 0)
    return QStringLiteral("—");
  double n = value;
  const QStringList units{QStringLiteral("B"), QStringLiteral("KiB"), QStringLiteral("MiB"),
                          QStringLiteral("GiB"), QStringLiteral("TiB")};
  int unit = 0;
  while (n >= 1024 && unit < 4) {
    n /= 1024;
    ++unit;
  }
  return QString::number(n, 'f', unit && n < 100 ? 1 : 0) + QLatin1Char(' ') + units[unit];
}
QString elapsed(double seconds) {
  if (!std::isfinite(seconds) || seconds < 0)
    return QStringLiteral("—");
  const auto n = qint64(seconds);
  return n >= 3600 ? QStringLiteral("%1:%2:%3")
                         .arg(n / 3600)
                         .arg(n / 60 % 60, 2, 10, QLatin1Char('0'))
                         .arg(n % 60, 2, 10, QLatin1Char('0'))
                   : QStringLiteral("%1:%2").arg(n / 60).arg(n % 60, 2, 10, QLatin1Char('0'));
}
QString age(qint64 timestamp, qint64 now) {
  if (now == 0)
    now = QDateTime::currentMSecsSinceEpoch();
  const auto seconds = std::max<qint64>(0, (now - timestamp) / 1000);
  if (seconds < 60)
    return QStringLiteral("just now");
  if (seconds < 3600)
    return QStringLiteral("%1 minute%2 ago")
        .arg(seconds / 60)
        .arg(seconds / 60 == 1 ? QString() : QStringLiteral("s"));
  if (seconds < 86400)
    return QStringLiteral("%1 hour%2 ago")
        .arg(seconds / 3600)
        .arg(seconds / 3600 == 1 ? QString() : QStringLiteral("s"));
  return QStringLiteral("%1 day%2 ago")
      .arg(seconds / 86400)
      .arg(seconds / 86400 == 1 ? QString() : QStringLiteral("s"));
}
TransferTable::TransferTable(TransferEngine &engine, QObject *parent)
    : QAbstractTableModel(parent), engine_(engine) {
  refresh_.setSingleShot(true);
  connect(&refresh_, &QTimer::timeout, this, &TransferTable::refresh);
  connect(&engine_, &TransferEngine::changed, this, [this] {
    if (!refresh_.isActive())
      refresh_.start(40);
  });
  refresh();
}
int TransferTable::rowCount(const QModelIndex &p) const {
  return p.isValid() ? 0 : rows_.size();
}
int TransferTable::columnCount(const QModelIndex &) const {
  return 12;
}
TransferView TransferTable::row(int i) const {
  return i >= 0 && i < rows_.size() ? rows_[i] : TransferView();
}
int TransferTable::indexOf(const QString &id) const {
  for (int i = 0; i < rows_.size(); ++i)
    if (rows_[i].id == id)
      return i;
  return -1;
}
QVariant TransferTable::headerData(int section, Qt::Orientation orientation, int role) const {
  return orientation == Qt::Horizontal && role == Qt::DisplayRole && section >= 0 && section < 12
             ? transferHeaders()[section]
             : QVariant();
}
QVariant TransferTable::data(const QModelIndex &i, int role) const {
  if (!i.isValid() || i.row() >= rows_.size())
    return {};
  const auto &r = rows_[i.row()];
  const double progress = r.wanted > 0 ? std::clamp(double(r.verified) / r.wanted, 0.0, 1.0) : 0;
  if (role == IdRole)
    return r.id;
  if (role == ProgressRole)
    return progress;
  if (role == Qt::ToolTipRole)
    return r.name + QLatin1Char('\n') + r.reason + QLatin1Char('\n') + r.path;
  if (role == Qt::ForegroundRole && i.column() == 4)
    return QBrush(stateColor(r.state));
  if (role == Qt::TextAlignmentRole && i.column() != 1 && i.column() != 4 && i.column() != 11)
    return int(Qt::AlignRight | Qt::AlignVCenter);
  if (role == SortRole) {
    switch (i.column()) {
    case 0:
      return r.order;
    case 2:
      return r.wanted;
    case 3:
      return progress;
    case 5:
      return r.seeds;
    case 6:
      return r.peers;
    case 7:
      return r.downRate;
    case 8:
      return r.upRate;
    case 9:
      return r.downRate > 0 ? double(r.wanted - r.verified) / r.downRate : 1e20;
    case 10:
      return r.downloaded > 0 ? double(r.uploaded) / r.downloaded : 0;
    default:
      return data(i, Qt::DisplayRole);
    }
  }
  if (role != Qt::DisplayRole)
    return {};
  switch (i.column()) {
  case 0:
    return r.order + 1;
  case 1:
    return r.name;
  case 2:
    return r.metadata ? bytes(r.wanted) : QStringLiteral("—");
  case 3:
    return r.wanted > 0 ? QString::number(progress * 100, 'f', 1) + QLatin1Char('%') : QStringLiteral("—");
  case 4:
    return r.state;
  case 5:
    return r.seeds;
  case 6:
    return r.peers;
  case 7:
    return r.downRate > 0 ? bytes(r.downRate) + QStringLiteral("/s") : QStringLiteral("—");
  case 8:
    return r.upRate > 0 ? bytes(r.upRate) + QStringLiteral("/s") : QStringLiteral("—");
  case 9:
    return r.downRate > 0 && r.wanted > r.verified ? elapsed(double(r.wanted - r.verified) / r.downRate)
                                                   : QStringLiteral("—");
  case 10:
    return QString::number(r.downloaded > 0 ? double(r.uploaded) / r.downloaded : 0, 'f', 2);
  case 11:
    return r.path;
  }
  return {};
}
void TransferTable::refresh() {
  const auto incoming = engine_.transfers();
  QHash<QString, TransferView> byId;
  for (const auto &row : incoming)
    byId.insert(row.id, row);
  for (int i = rows_.size() - 1; i >= 0; --i)
    if (!byId.contains(rows_[i].id)) {
      beginRemoveRows({}, i, i);
      rows_.removeAt(i);
      endRemoveRows();
    }
  QSet<QString> existing;
  for (int i = 0; i < rows_.size(); ++i) {
    existing.insert(rows_[i].id);
    rows_[i] = byId.value(rows_[i].id);
    emit dataChanged(index(i, 0), index(i, 11));
  }
  for (const auto &row : incoming)
    if (!existing.contains(row.id)) {
      const int i = rows_.size();
      beginInsertRows({}, i, i);
      rows_.append(row);
      endInsertRows();
    }
}
FileTree::FileTree(QObject *parent) : QAbstractItemModel(parent), root_(std::make_unique<Node>()) {
}
FileTree::Node *FileTree::node(const QModelIndex &index) const {
  return index.isValid() ? static_cast<Node *>(index.internalPointer()) : root_.get();
}
QModelIndex FileTree::modelIndex(Node *n, int column) const {
  return n && n != root_.get() ? createIndex(n->row, column, n) : QModelIndex();
}
QModelIndex FileTree::index(int row, int column, const QModelIndex &parent) const {
  if (parent.isValid() && parent.column() != 0)
    return {};
  auto *p = node(parent);
  return row >= 0 && row < p->children.size() && column >= 0 && column < 5
             ? createIndex(row, column, p->children[row])
             : QModelIndex();
}
QModelIndex FileTree::parent(const QModelIndex &index) const {
  return index.isValid() ? modelIndex(node(index)->parent) : QModelIndex();
}
int FileTree::rowCount(const QModelIndex &parent) const {
  return parent.isValid() && parent.column() != 0 ? 0 : node(parent)->children.size();
}
int FileTree::columnCount(const QModelIndex &) const {
  return 5;
}
QVariant FileTree::headerData(int section, Qt::Orientation orientation, int role) const {
  static const QStringList names{QStringLiteral("Name"), QStringLiteral("Size"), QStringLiteral("Progress"),
                                 QStringLiteral("Files"), QStringLiteral("Priority")};
  return role == Qt::DisplayRole && orientation == Qt::Horizontal && section >= 0 && section < names.size()
             ? names[section]
             : QVariant();
}
QVariant FileTree::data(const QModelIndex &i, int role) const {
  if (!i.isValid())
    return {};
  const auto *n = node(i);
  if (role == IdRole)
    return n->file;
  if (role == Qt::ToolTipRole)
    return n->path;
  if (role == Qt::CheckStateRole && i.column() == 0)
    return n->selected == 0          ? int(Qt::Unchecked)
           : n->selected == n->count ? int(Qt::Checked)
                                     : int(Qt::PartiallyChecked);
  if (role == ProgressRole)
    return n->size > 0 ? double(n->verified) / n->size : 0;
  if (role == Qt::EditRole && i.column() == 4)
    return n->priority;
  if (role == Qt::ForegroundRole && n->selected == 0)
    return QBrush(QColor(QStringLiteral("#a1afc3")));
  if (role == Qt::DecorationRole && i.column() == 0)
    return qApp->style()->standardIcon(n->file >= 0 ? QStyle::SP_FileIcon : QStyle::SP_DirIcon);
  if (role == Qt::TextAlignmentRole && i.column() > 0 && i.column() < 4)
    return int(Qt::AlignRight | Qt::AlignVCenter);
  if (role != Qt::DisplayRole && role != SortRole)
    return {};
  switch (i.column()) {
  case 0:
    return n->label;
  case 1:
    return role == SortRole ? QVariant(n->size) : bytes(n->size);
  case 2:
    return n->size > 0 ? QString::number(double(n->verified) / n->size * 100, 'f', 1) + QLatin1Char('%')
                       : QStringLiteral("—");
  case 3:
    return n->file >= 0 ? QVariant() : QVariant(QStringLiteral("%1 / %2").arg(n->selected).arg(n->count));
  case 4:
    return priority(n->priority);
  }
  return {};
}
Qt::ItemFlags FileTree::flags(const QModelIndex &index) const {
  return index.isValid() ? Qt::ItemIsEnabled | Qt::ItemIsSelectable |
                               (index.column() == 0 ? Qt::ItemIsUserCheckable : Qt::NoItemFlags) |
                               (index.column() == 4 ? Qt::ItemIsEditable : Qt::NoItemFlags)
                         : Qt::NoItemFlags;
}
void FileTree::recount(Node *n) {
  if (n->file >= 0) {
    n->count = 1;
    n->selected = n->priority > 0 ? 1 : 0;
    n->chosenSize = n->selected ? n->size : 0;
    return;
  }
  n->count = 0;
  n->selected = 0;
  n->size = 0;
  n->verified = 0;
  n->chosenSize = 0;
  n->priority = -2;
  for (auto *child : n->children) {
    recount(child);
    if (n->priority == -2)
      n->priority = child->priority;
    else if (n->priority != child->priority)
      n->priority = -1;
    n->count += child->count;
    n->selected += child->selected;
    n->size += child->size;
    n->chosenSize += child->chosenSize;
    n->verified += child->verified;
  }
  if (n->priority == -2)
    n->priority = 0;
}
void FileTree::change(Node *n, int p) {
  if (n->file >= 0) {
    if (p == 0 && n->priority > 0)
      n->lastPriority = n->priority;
    n->priority = p < 0 ? n->lastPriority : p;
    if (n->priority > 0)
      n->lastPriority = n->priority;
  } else
    for (auto *child : n->children)
      change(child, p);
}
void FileTree::syncChoices(const QHash<int, int> &priorities) {
  if (dirty())
    return;
  bool changed = false;
  for (auto it = files_.begin(); it != files_.end(); ++it) {
    const int priority = priorities.value(it.key());
    if (it.value()->priority != priority) {
      change(it.value(), priority);
      changed = true;
    }
  }
  if (changed) {
    baseline_ = choices();
    notify();
    emit selectionChanged();
  }
}
void FileTree::setDraft(const QHash<int, int> &priorities) {
  for (auto it = files_.begin(); it != files_.end(); ++it)
    if (priorities.contains(it.key()))
      change(it.value(), priorities.value(it.key()));
  notify();
  emit selectionChanged();
}
void FileTree::notify() {
  recount(root_.get());
  for (auto *parent : [this] {
         QList<Node *> parents{root_.get()};
         for (const auto &n : nodes_)
           if (!n->children.isEmpty())
             parents.append(n.get());
         return parents;
       }())
    if (!parent->children.isEmpty())
      emit dataChanged(modelIndex(parent->children.first(), 0), modelIndex(parent->children.last(), 4));
  emit selectionChanged();
}
bool FileTree::setData(const QModelIndex &index, const QVariant &value, int role) {
  if (!index.isValid())
    return false;
  if (role == Qt::CheckStateRole && index.column() == 0)
    change(node(index), value.toInt() == Qt::Unchecked ? 0 : -1);
  else if (role == Qt::EditRole && index.column() == 4 && value.toInt() >= 0 && value.toInt() <= 7)
    change(node(index), value.toInt());
  else
    return false;
  notify();
  return true;
}
void FileTree::setFiles(const QList<TorrentFile> &files, const QHash<int, int> &priorities) {
  beginResetModel();
  root_ = std::make_unique<Node>();
  nodes_.clear();
  files_.clear();
  baseline_.clear();
  QHash<QString, Node *> folders;
  folders.insert(QString(), root_.get());
  for (const auto &f : files) {
    auto parts = f.path.split(QLatin1Char('/'), Qt::SkipEmptyParts);
    Node *parent = root_.get();
    QString path;
    for (int i = 0; i < parts.size(); ++i) {
      const auto prefix = path.isEmpty() ? parts[i] : path + QLatin1Char('/') + parts[i];
      const bool leaf = i == parts.size() - 1;
      if (!leaf && folders.contains(prefix))
        parent = folders.value(prefix);
      else {
        auto child = std::make_unique<Node>();
        child->parent = parent;
        child->label = parts[i];
        child->path = prefix;
        if (leaf) {
          child->file = f.index;
          child->size = f.size;
          child->priority = std::clamp(priorities.value(f.index), 0, 7);
          child->lastPriority = child->priority > 0 ? child->priority : 4;
          files_.insert(f.index, child.get());
          baseline_.insert(f.index, child->priority);
        } else
          folders.insert(prefix, child.get());
        parent->children.append(child.get());
        parent = child.get();
        nodes_.push_back(std::move(child));
      }
      path = prefix;
    }
  }
  QCollator collator(QLocale(QLocale::English));
  collator.setNumericMode(true);
  collator.setCaseSensitivity(Qt::CaseInsensitive);
  for (auto *folder : folders) {
    std::sort(folder->children.begin(), folder->children.end(), [&](Node *a, Node *b) {
      if ((a->file < 0) != (b->file < 0))
        return a->file < 0;
      return collator.compare(a->label, b->label) < 0;
    });
    for (int i = 0; i < folder->children.size(); ++i)
      folder->children[i]->row = i;
  }
  recount(root_.get());
  endResetModel();
  emit selectionChanged();
}
void FileTree::setProgress(const QList<qint64> &progress) {
  for (auto it = files_.begin(); it != files_.end(); ++it)
    it.value()->verified = it.key() >= 0 && it.key() < progress.size()
                               ? std::clamp(progress[it.key()], qint64(0), it.value()->size)
                               : 0;
  recount(root_.get());
  for (auto *p : [this] {
         QList<Node *> parents{root_.get()};
         for (const auto &n : nodes_)
           if (!n->children.isEmpty())
             parents.append(n.get());
         return parents;
       }())
    if (!p->children.isEmpty())
      emit dataChanged(modelIndex(p->children.first(), 2), modelIndex(p->children.last(), 2));
}
void FileTree::chooseAll(bool selected, bool excludeExtras) {
  for (auto it = files_.begin(); it != files_.end(); ++it)
    change(it.value(), selected && (!excludeExtras || (TransferEngine::video(it.value()->path) &&
                                                       !TransferEngine::extra(it.value()->path)))
                           ? -1
                           : 0);
  notify();
}
QHash<int, int> FileTree::choices() const {
  QHash<int, int> result;
  for (auto it = files_.begin(); it != files_.end(); ++it)
    result.insert(it.key(), it.value()->priority);
  return result;
}
QList<int> FileTree::selected() const {
  QList<int> result;
  for (auto it = files_.begin(); it != files_.end(); ++it)
    if (it.value()->priority > 0)
      result.append(it.key());
  std::sort(result.begin(), result.end());
  return result;
}
qint64 FileTree::selectedBytes() const {
  return root_->chosenSize;
}
int FileTree::selectedCount() const {
  return root_->selected;
}
bool FileTree::dirty() const {
  return choices() != baseline_;
}
QModelIndex FileTree::fileIndex(int index) const {
  return modelIndex(files_.value(index));
}
JsonTable::JsonTable(JsonKind kind, QObject *parent) : QAbstractTableModel(parent), kind_(kind) {
}
int JsonTable::rowCount(const QModelIndex &p) const {
  return p.isValid() ? 0 : rows_.size();
}
int JsonTable::columnCount(const QModelIndex &) const {
  return headers(kind_).size();
}
QVariant JsonTable::headerData(int section, Qt::Orientation orientation, int role) const {
  const auto names = headers(kind_);
  return role == Qt::DisplayRole && orientation == Qt::Horizontal && section >= 0 && section < names.size()
             ? names[section]
             : QVariant();
}
QJsonObject JsonTable::row(int index) const {
  return index >= 0 && index < rows_.size() ? rows_[index].toObject() : QJsonObject();
}
QString JsonTable::id(const QJsonObject &r) const {
  if (r.contains(QStringLiteral("id")))
    return r.value(QStringLiteral("id")).toString();
  if (kind_ == JsonKind::Trackers)
    return r.value(QStringLiteral("url")).toString();
  if (kind_ == JsonKind::Peers)
    return r.value(QStringLiteral("address")).toString() + QLatin1Char(':') +
           QString::number(r.value(QStringLiteral("port")).toInt());
  return {};
}
int JsonTable::indexOf(const QString &key) const {
  for (int i = 0; i < rows_.size(); ++i)
    if (id(rows_[i].toObject()) == key)
      return i;
  return -1;
}
void JsonTable::setRows(const QJsonArray &rows) {
  bool same = rows.size() == rows_.size();
  if (same)
    for (int i = 0; i < rows.size(); ++i)
      if (id(rows[i].toObject()) != id(rows_[i].toObject())) {
        same = false;
        break;
      }
  if (!same) {
    beginResetModel();
    rows_ = rows;
    endResetModel();
    return;
  }
  for (int i = 0; i < rows.size(); ++i)
    if (rows[i] != rows_[i]) {
      rows_[i] = rows[i];
      emit dataChanged(index(i, 0), index(i, columnCount() - 1));
    }
}
void JsonTable::setCurrent(const QString &entry) {
  if (current_ == entry)
    return;
  current_ = entry;
  if (!rows_.isEmpty())
    emit dataChanged(index(0, 0), index(rows_.size() - 1, 0));
}
void JsonTable::refreshAges() {
  if (kind_ == JsonKind::History && !rows_.isEmpty())
    emit dataChanged(index(0, 1), index(rows_.size() - 1, 1));
}
QVariant JsonTable::data(const QModelIndex &i, int role) const {
  if (!i.isValid() || i.row() >= rows_.size())
    return {};
  const auto r = row(i.row());
  if (role == IdRole)
    return id(r);
  if (role == ObjectRole)
    return QVariant::fromValue(r);
  const bool current = !current_.isEmpty() && (r.value(QStringLiteral("id")).toString() == current_ ||
                                               r.value(QStringLiteral("entryId")).toString() == current_);
  if (role == Qt::FontRole && current && i.column() == 0) {
    QFont font;
    font.setBold(true);
    return font;
  }
  if (role == Qt::ForegroundRole && current && i.column() == 0)
    return QBrush(QColor(QStringLiteral("#8fb7ff")));
  if (role == Qt::ToolTipRole)
    return kind_ == JsonKind::History
               ? QLocale().toString(
                     QDateTime::fromMSecsSinceEpoch(r.value(QStringLiteral("watchedAt")).toInteger())
                         .toLocalTime(),
                     QLocale::LongFormat)
               : r.value(QStringLiteral("error"))
                     .toString(r.value(QStringLiteral("path"))
                                   .toString(r.value(QStringLiteral("label")).toString()));
  if (role == ProgressRole)
    return kind_ == JsonKind::Peers ? r.value(QStringLiteral("progress")).toDouble()
           : r.value(QStringLiteral("state")).toString() == QStringLiteral("Ready") ? 1.0
           : r.value(QStringLiteral("total")).toDouble() > 0
               ? r.value(QStringLiteral("received")).toDouble() / r.value(QStringLiteral("total")).toDouble()
               : 0.0;
  if (role != Qt::DisplayRole && role != SortRole)
    return {};
  const auto col = i.column();
  const auto label = r.value(QStringLiteral("label")).toString();
  switch (kind_) {
  case JsonKind::Queue:
    if (col == 0) {
      const auto folder =
          QFileInfo(r.value(QStringLiteral("path")).toString()).path().section(QLatin1Char('/'), -1);
      return folder.isEmpty() || folder == QStringLiteral(".") ? label
                                                               : folder + QStringLiteral(" · ") + label;
    }
    if (col == 1)
      return r.value(QStringLiteral("watchedAt")).isDouble() ? QStringLiteral("Watched")
             : !r.value(QStringLiteral("enabled")).toBool()  ? QStringLiteral("Not selected")
                                                             : QStringLiteral("Upcoming");
    if (col == 2)
      return role == SortRole ? r.value(QStringLiteral("duration")).toVariant()
             : r.value(QStringLiteral("duration")).toDouble() > 0
                 ? elapsed(r.value(QStringLiteral("duration")).toDouble())
                 : QStringLiteral("—");
    return QFileInfo(r.value(QStringLiteral("path")).toString()).path();
  case JsonKind::History:
    if (col == 0)
      return label;
    if (col == 1)
      return role == SortRole ? r.value(QStringLiteral("watchedAt")).toVariant()
                              : age(r.value(QStringLiteral("watchedAt")).toInteger());
    if (col == 2)
      return r.value(QStringLiteral("duration")).toDouble() > 0
                 ? QString::number(std::min(100.0, r.value(QStringLiteral("coverage")).toDouble() /
                                                       r.value(QStringLiteral("duration")).toDouble() * 100),
                                   'f', 0) +
                       QLatin1Char('%')
                 : QStringLiteral("—");
    return r.value(QStringLiteral("method")).toString() == QStringLiteral("automatic")
               ? QStringLiteral("Automatically")
               : QStringLiteral("Marked watched");
  case JsonKind::Library:
    if (col == 0)
      return label;
    if (col == 1)
      return QFileInfo(r.value(QStringLiteral("path")).toString()).path();
    if (col == 2)
      return role == SortRole ? r.value(QStringLiteral("size")).toVariant()
                              : bytes(r.value(QStringLiteral("size")).toInteger());
    return r.value(QStringLiteral("missing")).toBool() ? QStringLiteral("Missing")
                                                       : QStringLiteral("Available");
  case JsonKind::Peers:
    if (col == 0)
      return r.value(QStringLiteral("address")).toString();
    if (col == 1)
      return r.value(QStringLiteral("client")).toString();
    if (col == 2)
      return role == SortRole
                 ? r.value(QStringLiteral("progress")).toVariant()
                 : QString::number(r.value(QStringLiteral("progress")).toDouble() * 100, 'f', 1) +
                       QLatin1Char('%');
    return role == SortRole
               ? r.value(col == 3 ? QStringLiteral("downRate") : QStringLiteral("upRate")).toVariant()
               : bytes(
                     r.value(col == 3 ? QStringLiteral("downRate") : QStringLiteral("upRate")).toInteger()) +
                     QStringLiteral("/s");
  case JsonKind::Trackers:
    if (col == 0)
      return r.value(QStringLiteral("url")).toString();
    if (col == 1)
      return r.value(QStringLiteral("tier")).toInt();
    {
      int failures = 0;
      for (auto value : r.value(QStringLiteral("endpoints")).toArray())
        failures += value.toObject().value(QStringLiteral("failures")).toInt();
      return failures ? QStringLiteral("%1 failure%2")
                            .arg(failures)
                            .arg(failures == 1 ? QString() : QStringLiteral("s"))
             : r.value(QStringLiteral("verified")).toBool() ? QStringLiteral("Working")
                                                            : QStringLiteral("Waiting for announce");
    }
  case JsonKind::Downloads:
    if (col == 0)
      return label;
    if (col == 1)
      return r.value(QStringLiteral("kind")).toString(QStringLiteral("Direct URL"));
    if (col == 2)
      return role == SortRole ? data(i, ProgressRole)
             : r.value(QStringLiteral("total")).toDouble() > 0 ||
                     r.value(QStringLiteral("state")).toString() == QStringLiteral("Ready")
                 ? QString::number(data(i, ProgressRole).toDouble() * 100, 'f', 1) + QLatin1Char('%')
                 : bytes(r.value(QStringLiteral("received")).toInteger());
    if (col == 3)
      return r.value(QStringLiteral("state")).toString();
    if (col == 4)
      return role == SortRole
                 ? r.value(QStringLiteral("downRate")).toVariant()
                 : QVariant(bytes(r.value(QStringLiteral("downRate")).toInteger()) + QStringLiteral("/s"));
    if (col == 6)
      return role == SortRole
                 ? QVariant(r.value(QStringLiteral("order")).toInteger(-1))
                 : QVariant(r.value(QStringLiteral("order")).toInteger(-1) < 0
                                ? QStringLiteral("—")
                                : QString::number(r.value(QStringLiteral("order")).toInteger() + 1));
    if (role == SortRole)
      return r.value(QStringLiteral("total")).toInteger(r.value(QStringLiteral("expectedSize")).toInteger());
    return bytes(
        r.value(QStringLiteral("total")).toInteger(r.value(QStringLiteral("expectedSize")).toInteger()));
  }
  return {};
}
void ProgressDelegate::paint(QPainter *painter, const QStyleOptionViewItem &option,
                             const QModelIndex &index) const {
  QStyledItemDelegate::paint(painter, option, index);
  const double value = std::clamp(index.data(ProgressRole).toDouble(), 0.0, 1.0);
  const auto bar = option.rect.adjusted(8, option.rect.height() - 6, -8, -3);
  painter->save();
  painter->setPen(Qt::NoPen);
  painter->setBrush(QColor(QStringLiteral("#27364b")));
  painter->drawRoundedRect(bar, 1.5, 1.5);
  painter->setBrush(QColor(QStringLiteral("#82adfa")));
  auto filled = bar;
  filled.setWidth(int(bar.width() * value));
  painter->drawRoundedRect(filled, 1.5, 1.5);
  painter->restore();
}
QWidget *PriorityDelegate::createEditor(QWidget *parent, const QStyleOptionViewItem &,
                                        const QModelIndex &) const {
  auto *combo = new QComboBox(parent);
  for (int p : {0, 1, 4, 6, 7})
    combo->addItem(priority(p), p);
  return combo;
}
void PriorityDelegate::setEditorData(QWidget *editor, const QModelIndex &index) const {
  auto *combo = qobject_cast<QComboBox *>(editor);
  combo->setCurrentIndex(std::max(0, combo->findData(index.data(Qt::EditRole))));
}
void PriorityDelegate::setModelData(QWidget *editor, QAbstractItemModel *model,
                                    const QModelIndex &index) const {
  model->setData(index, qobject_cast<QComboBox *>(editor)->currentData(), Qt::EditRole);
}
} // namespace wp::ui
