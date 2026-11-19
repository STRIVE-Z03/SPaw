"""SQLite connection and transaction ownership for the local application."""

import sqlite3
from contextlib import closing, contextmanager


def database(path):
    # WAL lets reads continue while a short write transaction commits.
    with closing(sqlite3.connect(path, timeout=20)) as initializer:
        initializer.execute("PRAGMA journal_mode = WAL")

    @contextmanager
    def connect():
        connection = sqlite3.connect(path, timeout=20)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            with connection:
                yield connection
        finally:
            connection.close()

    return connect
