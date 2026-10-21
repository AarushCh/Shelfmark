"""Domain model.

    User (abstract)                 single-table inheritance on users.role
    ├── Member (abstract)           borrowing policy is polymorphic
    │   ├── Student
    │   └── Faculty
    └── Librarian

    Book 1 ── * BookItem 1 ── * Loan 1 ── 0..1 Fine
    Book 1 ── * Reservation * ── 1 Member
"""
from __future__ import annotations

import hashlib
import hmac
import os
from datetime import date, datetime
from typing import ClassVar

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


class LibraryError(Exception):
    """A business rule from the case study was broken; the message is shown to the user."""


class NotFound(LibraryError):
    pass


class ItemStatus:
    AVAILABLE = "available"
    LOANED = "loaned"
    ON_HOLD = "on_hold"
    LOST = "lost"


class ReservationStatus:
    WAITING = "waiting"
    READY = "ready"
    FULFILLED = "fulfilled"
    CANCELLED = "cancelled"
    EXPIRED = "expired"
    OPEN = (WAITING, READY)


def _scrypt(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    return f"{salt.hex()}${_scrypt(password, salt).hex()}"


class User(Base):
    """Anyone holding a library card."""

    __tablename__ = "users"
    __mapper_args__ = {"polymorphic_on": "role", "polymorphic_abstract": True}
    label: ClassVar[str] = "User"

    id: Mapped[int] = mapped_column(primary_key=True)
    role: Mapped[str] = mapped_column(String(16))
    name: Mapped[str] = mapped_column(String(120))
    email: Mapped[str] = mapped_column(String(160), unique=True)
    password_hash: Mapped[str] = mapped_column(String(200))
    card_no: Mapped[str] = mapped_column(String(20), unique=True)  # barcode printed on the library card
    active: Mapped[bool] = mapped_column(default=True)
    joined_on: Mapped[date] = mapped_column(default=date.today)

    notifications: Mapped[list[Notification]] = relationship(back_populates="user")

    def set_password(self, password: str) -> None:
        self.password_hash = hash_password(password)

    def check_password(self, password: str) -> bool:
        salt, digest = self.password_hash.split("$")
        return hmac.compare_digest(bytes.fromhex(digest), _scrypt(password, bytes.fromhex(salt)))


class Member(User):
    """A borrower. Each subclass states its own policy, so no rule ever switches on a type code."""

    __mapper_args__ = {"polymorphic_abstract": True}
    label = "Member"
    max_books: ClassVar[int]
    loan_days: ClassVar[int]
    fine_per_day: ClassVar[int]  # rupees

    loans: Mapped[list[Loan]] = relationship(back_populates="member", order_by="Loan.id.desc()")
    reservations: Mapped[list[Reservation]] = relationship(back_populates="member", order_by="Reservation.id.desc()")
    fines: Mapped[list[Fine]] = relationship(back_populates="member", order_by="Fine.id.desc()")

    @property
    def active_loans(self) -> list[Loan]:
        return [loan for loan in self.loans if loan.returned_on is None]

    @property
    def fines_due(self) -> int:
        return sum(fine.amount for fine in self.fines if fine.paid_on is None)

    def ensure_can_borrow(self) -> None:
        if not self.active:
            raise LibraryError(f"{self.name}'s membership is suspended.")
        if self.fines_due:
            raise LibraryError(f"{self.name} has ₹{self.fines_due} in unpaid fines.")
        if len(self.active_loans) >= self.max_books:
            raise LibraryError(f"{self.label} members can hold at most {self.max_books} books at a time.")


class Student(Member):
    __mapper_args__ = {"polymorphic_identity": "student"}
    label = "Student"
    max_books = 5
    loan_days = 10
    fine_per_day = 5


class Faculty(Member):
    __mapper_args__ = {"polymorphic_identity": "faculty"}
    label = "Faculty"
    max_books = 10
    loan_days = 30
    fine_per_day = 2


class Librarian(User):
    __mapper_args__ = {"polymorphic_identity": "librarian"}
    label = "Librarian"


MEMBER_TYPES: dict[str, type[Member]] = {"student": Student, "faculty": Faculty}


class Book(Base):
    """A title in the catalogue, identified by ISBN. The physical copies are BookItems."""

    __tablename__ = "books"
    id: Mapped[int] = mapped_column(primary_key=True)
    isbn: Mapped[str] = mapped_column(String(13), unique=True)
    title: Mapped[str] = mapped_column(String(300))
    author: Mapped[str] = mapped_column(String(200))
    subject: Mapped[str] = mapped_column(String(60), index=True)
    publisher: Mapped[str | None] = mapped_column(String(200))
    year: Mapped[int | None]
    pages: Mapped[int | None]
    cover_id: Mapped[int | None]  # Open Library cover
    description: Mapped[str | None] = mapped_column(Text)
    added_on: Mapped[date] = mapped_column(default=date.today)

    items: Mapped[list[BookItem]] = relationship(back_populates="book", order_by="BookItem.barcode")
    reservations: Mapped[list[Reservation]] = relationship(back_populates="book", order_by="Reservation.id")

    def count(self, status: str) -> int:
        return sum(item.status == status for item in self.items)

    @property
    def queue(self) -> list[Reservation]:
        """Members waiting for this title, first come first served."""
        return [r for r in self.reservations if r.status == ReservationStatus.WAITING]


class BookItem(Base):
    """One physical copy: the barcode on its spine and the rack it lives on."""

    __tablename__ = "book_items"
    barcode: Mapped[str] = mapped_column(String(20), primary_key=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"), index=True)
    rack: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(12), default=ItemStatus.AVAILABLE)
    acquired_on: Mapped[date] = mapped_column(default=date.today)

    book: Mapped[Book] = relationship(back_populates="items")
    loans: Mapped[list[Loan]] = relationship(back_populates="item", order_by="Loan.id.desc()")

    @property
    def current_loan(self) -> Loan | None:
        return next((loan for loan in self.loans if loan.returned_on is None), None)


class Loan(Base):
    """A copy lent to a member (the case study's 'book lending')."""

    __tablename__ = "loans"
    id: Mapped[int] = mapped_column(primary_key=True)
    barcode: Mapped[str] = mapped_column(ForeignKey("book_items.barcode"), index=True)
    member_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    issued_on: Mapped[date]
    due_on: Mapped[date]
    returned_on: Mapped[date | None]
    renewals: Mapped[int] = mapped_column(default=0)
    overdue_notified: Mapped[bool] = mapped_column(default=False)

    item: Mapped[BookItem] = relationship(back_populates="loans")
    member: Mapped[Member] = relationship(back_populates="loans")
    fine: Mapped[Fine | None] = relationship(back_populates="loan")

    def days_overdue(self, on: date) -> int:
        return max(0, ((self.returned_on or on) - self.due_on).days)


class Reservation(Base):
    """A member's place in the queue for a title that has no copy on the shelf."""

    __tablename__ = "reservations"
    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int] = mapped_column(ForeignKey("books.id"), index=True)
    member_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    status: Mapped[str] = mapped_column(String(12), default=ReservationStatus.WAITING)
    created_at: Mapped[datetime]
    barcode: Mapped[str | None] = mapped_column(ForeignKey("book_items.barcode"))  # the copy held once ready
    hold_until: Mapped[date | None]

    book: Mapped[Book] = relationship(back_populates="reservations")
    member: Mapped[Member] = relationship(back_populates="reservations")
    item: Mapped[BookItem | None] = relationship()


class Fine(Base):
    """Raised when a loan comes back late: days overdue × the member's daily rate."""

    __tablename__ = "fines"
    id: Mapped[int] = mapped_column(primary_key=True)
    loan_id: Mapped[int] = mapped_column(ForeignKey("loans.id"), unique=True)
    member_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    amount: Mapped[int]
    created_on: Mapped[date]
    paid_on: Mapped[date | None]

    loan: Mapped[Loan] = relationship(back_populates="fine")
    member: Mapped[Member] = relationship(back_populates="fines")


class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(24))
    message: Mapped[str] = mapped_column(String(300))
    created_at: Mapped[datetime]
    read: Mapped[bool] = mapped_column(default=False)

    user: Mapped[User] = relationship(back_populates="notifications")


class Activity(Base):
    """The circulation desk's audit trail."""

    __tablename__ = "activity"
    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(index=True)
    kind: Mapped[str] = mapped_column(String(24))
    message: Mapped[str] = mapped_column(String(300))
