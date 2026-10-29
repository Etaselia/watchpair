#pragma once
#include "local_store.h"
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QSaveFile>
#include <QUuid>
namespace wp::owned {
inline bool directory(const QJsonObject &row) {
  const auto root = row.value(QStringLiteral("root")).toString();
  const QFileInfo info(root);
  if (root.isEmpty() || !info.isDir() || info.isSymLink() || info.canonicalFilePath() != root)
    return false;
  QFile marker(root + QStringLiteral("/.watchpair-owner"));
  if (QFileInfo(marker).isSymLink() || !marker.open(QIODevice::ReadOnly) || marker.size() > 2048)
    return false;
  const auto value = QJsonDocument::fromJson(marker.readAll()).object();
  return !row.value(QStringLiteral("nonce")).toString().isEmpty() &&
         value.value(QStringLiteral("nonce")) == row.value(QStringLiteral("nonce")) &&
         value.value(QStringLiteral("id")) == row.value(QStringLiteral("id"));
}
inline bool file(const QJsonObject &row, const QString &path) {
  return directory(row) && !QFileInfo(path).isSymLink() &&
         QFileInfo(path).dir().canonicalPath() == row.value(QStringLiteral("root")).toString();
}
inline QString allocate(const QString &base, const QString &id, const QString &nonce) {
  if (!QDir().mkpath(base))
    throw AppError(QStringLiteral("STORAGE_ACCESS"), QStringLiteral("Cannot open the download folder."));
  const auto root =
      QDir(QDir(base).canonicalPath())
          .filePath(QStringLiteral("watchpair-copy-") + QUuid::createUuid().toString(QUuid::WithoutBraces));
  if (QFileInfo::exists(root) || !QDir().mkdir(root))
    throw AppError(QStringLiteral("STORAGE_ACCESS"),
                   QStringLiteral("Cannot allocate an owned download folder."));
  QSaveFile marker(root + QStringLiteral("/.watchpair-owner"));
  const auto bytes = QJsonDocument(QJsonObject{{QStringLiteral("id"), id}, {QStringLiteral("nonce"), nonce}})
                         .toJson(QJsonDocument::Compact);
  if (!marker.open(QIODevice::WriteOnly) || marker.write(bytes) != bytes.size() || !marker.commit())
    throw AppError(QStringLiteral("STORAGE_ACCESS"),
                   QStringLiteral("Cannot record download folder ownership."));
  return QDir(root).canonicalPath();
}
} // namespace wp::owned
