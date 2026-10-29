#pragma once
#include "local_store.h"
namespace wp {
// Call inside the same LocalStore transaction that records physical removal.
// This function only changes durable intent; native/network reconciliation is
// performed after commit. A crash cannot resurrect a user-removed download.
inline void refuseRoomAcquisition(LocalStore &store, const QString &field, const QString &id) {
  for (auto value : store.find(QStringLiteral("room-source"), field, id)) {
    auto row = value.toObject();
    const auto room = row.value(QStringLiteral("room")).toString(),
               source = row.value(QStringLiteral("source")).toString(),
               key = room + QLatin1Char(':') + source;
    if (row.value(QStringLiteral("removed")).toBool())
      continue;
    row.insert(QStringLiteral("removed"), true);
    store.put(QStringLiteral("room-source"), key, row);
    auto policy = store.get(QStringLiteral("source-policy"), key);
    policy.insert(QStringLiteral("id"), key);
    policy.insert(QStringLiteral("room"), room);
    policy.insert(QStringLiteral("source"), source);
    policy.insert(QStringLiteral("override"), QStringLiteral("Never"));
    policy.insert(QStringLiteral("approved"), QJsonArray());
    policy.insert(QStringLiteral("decisionRevision"),
                  policy.value(QStringLiteral("decisionRevision")).toInteger() + 1);
    store.put(QStringLiteral("source-policy"), key, policy);
  }
}
} // namespace wp
