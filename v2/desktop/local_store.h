#pragma once
#include <QJsonArray>
#include <QJsonObject>
#include <QSqlDatabase>
#include <QString>
#include <functional>
#include <stdexcept>

namespace wp {
class AppError : public std::runtime_error {
public:
  AppError(QString code, QString message)
      : std::runtime_error(message.toStdString()), code_(std::move(code)), message_(std::move(message)) {}
  QString code() const { return code_; }
  QString message() const { return message_; }

private:
  QString code_, message_;
};
class LocalStore final {
public:
  explicit LocalStore(const QString &profile);
  ~LocalStore();
  QString profile() const { return profile_; }
  QJsonObject get(const QString &kind, const QString &id) const;
  QJsonArray all(const QString &kind) const;
  QJsonArray find(const QString &kind, const QString &field, const QString &value) const;
  void put(const QString &kind, const QString &id, const QJsonObject &data);
  void remove(const QString &kind, const QString &id);
  void transaction(const std::function<void()> &fn);
  QJsonValue setting(const QString &key, const QJsonValue &fallback = {}) const;
  void setSetting(const QString &key, const QJsonValue &value);
  void backup(const QString &destination);

private:
  QSqlDatabase db_;
  QString profile_, connection_;
  bool inTransaction_ = false;
};
} // namespace wp
