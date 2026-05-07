"""Скрипт для приведения всех nickname в users и user_profiles к нижнему регистру."""

import sys
import os

from sqlalchemy import func, update

# Добавляем корневую директорию проекта в sys.path, чтобы скрипт видел модули
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from database import profiles_table, session_scope, users_table


def lowercase_nicknames(table) -> None:
    with session_scope() as session:
        stmt = update(table).values(nickname=func.lower(table.c.nickname))
        session.execute(stmt)


def main() -> None:
    print("Приведение nicknames в таблицах users и user_profiles к нижнему регистру...")
    lowercase_nicknames(users_table)
    lowercase_nicknames(profiles_table)
    print("Готово.")


if __name__ == "__main__":
    main()
