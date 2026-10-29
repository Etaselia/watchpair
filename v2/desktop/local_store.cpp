#include "local_store.h"
#include "profile_security.h"
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QSqlError>
#include <QSqlQuery>
#include <QUuid>

namespace wp {
namespace {
void execute(QSqlQuery &query) {
  if (!query.exec())
    throw AppError(QStringLiteral("LOCAL_STORAGE"),
                   QStringLiteral("Could not save local state. Check free space and profile access."));
}
QJsonObject object(const QVariant &data) {
  QJsonParseError error;
  const auto doc = QJsonDocument::fromJson(data.toByteArray(), &error);
  if (error.error != QJsonParseError::NoError || !doc.isObject())
    throw AppError(QStringLiteral("CORRUPT_STATE"),
                   QStringLiteral("A local state record is damaged. Restore a profile backup."));
  return doc.object();
}
} // namespace
LocalStore::LocalStore(const QString &profile)
    : profile_(QDir(profile).absolutePath()), connection_(QUuid::createUuid().toString()) {
  secureProfile(profile_);
  db_ = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connection_);
  db_.setDatabaseName(profile_ + QStringLiteral("/watchpair-v2.sqlite"));
  db_.setConnectOptions(QStringLiteral("QSQLITE_BUSY_TIMEOUT=5000"));
  try {
    if (!db_.open())
      throw AppError(QStringLiteral("PROFILE_DATABASE"),
                     QStringLiteral("Cannot open the WatchPair profile database."));
    QSqlQuery q(db_);
    q.exec(QStringLiteral("PRAGMA user_version"));
    if (q.next() && q.value(0).toInt() > 1)
      throw AppError(QStringLiteral("PROFILE_NEWER"),
                     QStringLiteral("This profile needs a newer WatchPair version."));
    for (const auto &sql :
         {QStringLiteral("PRAGMA journal_mode=WAL"), QStringLiteral("PRAGMA synchronous=FULL"),
          QStringLiteral("CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,data BLOB "
                         "NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(kind,id))"),
          QStringLiteral("CREATE INDEX IF NOT EXISTS objects_kind ON objects(kind,updated_at DESC)"),
          QStringLiteral("CREATE INDEX IF NOT EXISTS library_identity ON "
                         "objects(json_extract(data,'$.sha256')) WHERE kind='library-file'"),
          QStringLiteral("PRAGMA user_version=1")}) {
      if (!q.exec(sql))
        throw AppError(QStringLiteral("PROFILE_SCHEMA"),
                       QStringLiteral("Cannot initialize the local database."));
    }
#ifndef Q_OS_WIN
    QFile::setPermissions(db_.databaseName(), QFile::ReadOwner | QFile::WriteOwner);
#endif
  } catch (...) {
    db_.close();
    db_ = {};
    QSqlDatabase::removeDatabase(connection_);
    throw;
  }
}
void LocalStore::backup(const QString &destination) {
  if (inTransaction_ || QFileInfo::exists(destination))
    throw AppError(QStringLiteral("PROFILE_BACKUP"),
                   QStringLiteral("A profile backup needs a fresh destination outside a transaction."));
  QSqlQuery query(db_);
  query.prepare(QStringLiteral("VACUUM INTO ?"));
  query.addBindValue(destination);
  execute(query);
  QFile::setPermissions(destination, QFile::ReadOwner | QFile::WriteOwner);
}
LocalStore::~LocalStore() {
  db_.close();
  db_ = {};
  QSqlDatabase::removeDatabase(connection_);
}
QJsonObject LocalStore::get(const QString &kind, const QString &id) const {
  QSqlQuery q(db_);
  q.prepare(QStringLiteral("SELECT data FROM objects WHERE kind=? AND id=?"));
  q.addBindValue(kind);
  q.addBindValue(id);
  execute(q);
  return q.next() ? object(q.value(0)) : QJsonObject();
}
QJsonArray LocalStore::all(const QString &kind) const {
  QSqlQuery q(db_);
  q.prepare(QStringLiteral("SELECT data FROM objects WHERE kind=? ORDER BY updated_at DESC,id"));
  q.addBindValue(kind);
  execute(q);
  QJsonArray out;
  while (q.next())
    out.append(object(q.value(0)));
  return out;
}
QJsonArray LocalStore::find(const QString &kind, const QString &field, const QString &value) const {
  if (!QRegularExpression(QStringLiteral("^[A-Za-z][A-Za-z0-9_]*$")).match(field).hasMatch())
    throw AppError(QStringLiteral("INVALID_QUERY"), QStringLiteral("Invalid local query field."));
  QSqlQuery q(db_);
  q.prepare(
      QStringLiteral("SELECT data FROM objects WHERE kind=? AND json_extract(data,'$.%1')=?").arg(field));
  q.addBindValue(kind);
  q.addBindValue(value);
  execute(q);
  QJsonArray out;
  while (q.next())
    out.append(object(q.value(0)));
  return out;
}
void LocalStore::put(const QString &kind, const QString &id, const QJsonObject &data) {
  QSqlQuery q(db_);
  q.prepare(
      QStringLiteral("INSERT INTO objects(kind,id,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO "
                     "UPDATE SET data=excluded.data,updated_at=excluded.updated_at"));
  q.addBindValue(kind);
  q.addBindValue(id);
  q.addBindValue(QJsonDocument(data).toJson(QJsonDocument::Compact));
  q.addBindValue(QDateTime::currentMSecsSinceEpoch());
  execute(q);
}
void LocalStore::remove(const QString &kind, const QString &id) {
  QSqlQuery q(db_);
  q.prepare(QStringLiteral("DELETE FROM objects WHERE kind=? AND id=?"));
  q.addBindValue(kind);
  q.addBindValue(id);
  execute(q);
}
void LocalStore::transaction(const std::function<void()> &fn) {
  if (inTransaction_)
    throw AppError(QStringLiteral("NESTED_TRANSACTION"),
                   QStringLiteral("Unexpected nested local transaction."));
  if (!db_.transaction())
    throw AppError(QStringLiteral("LOCAL_STORAGE"),
                   QStringLiteral("Cannot start a local state transaction."));
  inTransaction_ = true;
  try {
    fn();
    if (!db_.commit())
      throw AppError(QStringLiteral("LOCAL_STORAGE"), QStringLiteral("Cannot commit local state."));
    inTransaction_ = false;
  } catch (...) {
    db_.rollback();
    inTransaction_ = false;
    throw;
  }
}
QJsonValue LocalStore::setting(const QString &key, const QJsonValue &fallback) const {
  const auto row = get(QStringLiteral("setting"), key);
  return row.contains(QStringLiteral("value")) ? row.value(QStringLiteral("value")) : fallback;
}
void LocalStore::setSetting(const QString &key, const QJsonValue &value) {
  put(QStringLiteral("setting"), key, {{QStringLiteral("value"), value}});
}
} // namespace wp
