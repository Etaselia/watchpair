#pragma once
#include "transfer_engine.h"
#include <QAbstractItemModel>
#include <QAbstractTableModel>
#include <QJsonObject>
#include <QStyledItemDelegate>
#include <QTimer>
#include <memory>
#include <optional>
#include <vector>
namespace wp::ui {
enum Roles { SortRole = Qt::UserRole + 1, ProgressRole, IdRole, ObjectRole, SearchRole };
QString bytes(qint64 value);
QString elapsed(double seconds);
QString age(qint64 timestamp, qint64 now = 0);
// Protocol timestamps are numeric Unix milliseconds. Legacy coordinators may
// send fractional milliseconds; never infer a seconds unit or turn null into 0.
std::optional<qint64> timestampMilliseconds(const QJsonValue &value);
bool upcoming(const QJsonObject &entry);
class TransferTable final : public QAbstractTableModel {
  Q_OBJECT
public:
  explicit TransferTable(TransferEngine &engine, QObject *parent = nullptr);
  int rowCount(const QModelIndex &parent = {}) const override;
  int columnCount(const QModelIndex &parent = {}) const override;
  QVariant data(const QModelIndex &index, int role) const override;
  QVariant headerData(int section, Qt::Orientation orientation, int role) const override;
  TransferView row(int index) const;
  int indexOf(const QString &id) const;
  void refresh();

private:
  TransferEngine &engine_;
  QList<TransferView> rows_;
  QTimer refresh_;
};
class FileTree final : public QAbstractItemModel {
  Q_OBJECT
public:
  explicit FileTree(QObject *parent = nullptr);
  QModelIndex index(int row, int column, const QModelIndex &parent = {}) const override;
  QModelIndex parent(const QModelIndex &index) const override;
  int rowCount(const QModelIndex &parent = {}) const override;
  int columnCount(const QModelIndex &parent = {}) const override;
  QVariant data(const QModelIndex &index, int role) const override;
  QVariant headerData(int section, Qt::Orientation orientation, int role) const override;
  Qt::ItemFlags flags(const QModelIndex &index) const override;
  bool setData(const QModelIndex &index, const QVariant &value, int role) override;
  void setFiles(const QList<TorrentFile> &files, const QHash<int, int> &priorities);
  void setProgress(const QList<qint64> &progress);
  void syncChoices(const QHash<int, int> &priorities);
  void setDraft(const QHash<int, int> &priorities);
  void chooseAll(bool selected, bool excludeExtras = false);
  QHash<int, int> choices() const;
  QList<int> selected() const;
  qint64 selectedBytes() const;
  int selectedCount() const;
  bool dirty() const;
  QModelIndex fileIndex(int manifestIndex) const;
signals:
  void selectionChanged();

private:
  struct Node {
    Node *parent = nullptr;
    QList<Node *> children;
    QString label, path;
    int row = 0, file = -1, priority = 0, lastPriority = 4, selected = 0, count = 0;
    qint64 size = 0, verified = 0, chosenSize = 0;
  };
  Node *node(const QModelIndex &index) const;
  QModelIndex modelIndex(Node *node, int column = 0) const;
  void recount(Node *node);
  void change(Node *node, int priority);
  void notify();
  std::unique_ptr<Node> root_;
  std::vector<std::unique_ptr<Node>> nodes_;
  QHash<int, Node *> files_;
  QHash<int, int> baseline_;
};
enum class JsonKind { Queue, History, Library, Peers, Trackers, Downloads };
class JsonTable final : public QAbstractTableModel {
  Q_OBJECT
public:
  explicit JsonTable(JsonKind kind, QObject *parent = nullptr);
  int rowCount(const QModelIndex &parent = {}) const override;
  int columnCount(const QModelIndex &parent = {}) const override;
  QVariant data(const QModelIndex &index, int role) const override;
  QVariant headerData(int section, Qt::Orientation orientation, int role) const override;
  void setRows(const QJsonArray &rows);
  QJsonObject row(int index) const;
  int indexOf(const QString &id) const;
  void setCurrent(const QString &entryId);
  void refreshAges();

private:
  QString id(const QJsonObject &row) const;
  JsonKind kind_;
  QJsonArray rows_;
  QString current_;
};
class ProgressDelegate final : public QStyledItemDelegate {
public:
  using QStyledItemDelegate::QStyledItemDelegate;
  void paint(QPainter *painter, const QStyleOptionViewItem &option, const QModelIndex &index) const override;
};
class PriorityDelegate final : public QStyledItemDelegate {
public:
  using QStyledItemDelegate::QStyledItemDelegate;
  QWidget *createEditor(QWidget *parent, const QStyleOptionViewItem &, const QModelIndex &) const override;
  void setEditorData(QWidget *editor, const QModelIndex &index) const override;
  void setModelData(QWidget *editor, QAbstractItemModel *model, const QModelIndex &index) const override;
};
} // namespace wp::ui
