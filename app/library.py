"""Circulation use cases (Facade) and the observers that react to them (Observer)."""
from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import date, datetime, time, timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from .models import (
    MEMBER_TYPES, Activity, Book, BookItem, Fine, ItemStatus, LibraryError, Loan, Member, NotFound,
    Notification, Reservation, ReservationStatus, User,
)


class Observer(ABC):
    """Told about every circulation event the Library publishes."""

    def __init__(self, session: Session):
        self.session = session

    @abstractmethod
    def update(self, event: str, at: datetime, **data) -> None: ...


class MemberNotifier(Observer):
    """In-app notices: reserved book available, book overdue, fines."""

    TEMPLATES = {
        "issued": "You borrowed “{title}”. Please return it by {due.day} {due:%b}.",
        "renewed": "“{title}” is renewed and now due {due.day} {due:%b}.",
        "reservation_ready": "“{title}” is waiting for you at the desk until {until.day} {until:%b}.",
        "hold_expired": "Your hold on “{title}” expired before it was collected.",
        "overdue": "“{title}” was due on {due.day} {due:%b}. Late fee is ₹{rate} a day.",
        "fine": "₹{amount} fine for returning “{title}” {days} day(s) late.",
    }

    def update(self, event, at, member=None, **data):
        if member is not None and event in self.TEMPLATES:
            message = self.TEMPLATES[event].format(**data)
            self.session.add(Notification(user=member, kind=event, message=message, created_at=at, read=False))


class ActivityLog(Observer):
    """The live feed on the librarian dashboard."""

    TEMPLATES = {
        "issued": "{member.name} borrowed “{title}”",
        "returned": "“{title}” returned by {member.name}",
        "renewed": "{member.name} renewed “{title}”",
        "reserved": "{member.name} reserved “{title}”",
        "reservation_ready": "Copy {barcode} held for {member.name}",
        "hold_expired": "{member.name}'s hold on “{title}” expired",
        "fine": "₹{amount} fine raised for {member.name}",
        "fine_paid": "{member.name} paid a ₹{amount} fine",
        "joined": "{member.name} joined as {member.label}",
        "catalogued": "“{title}” added to the catalogue",
    }

    def update(self, event, at, **data):
        if event in self.TEMPLATES:
            self.session.add(Activity(kind=event, at=at, message=self.TEMPLATES[event].format(**data)))


class Library:
    """Facade over the circulation desk. Every use case in the case study goes through here."""

    HOLD_DAYS = 3
    MAX_RENEWALS = 1

    def __init__(self, session: Session, today: date | None = None):
        self.session = session
        self.today = today or date.today()
        self.clock: time | None = None  # pinned time of day, used when replaying history
        self.observers: list[Observer] = [MemberNotifier(session), ActivityLog(session)]

    @property
    def now(self) -> datetime:
        return datetime.combine(self.today, self.clock or datetime.now().time())

    def _publish(self, event: str, **data) -> None:
        for observer in self.observers:
            observer.update(event, self.now, **data)

    # lookups ---------------------------------------------------------------------------------

    def get(self, model, key):
        obj = self.session.get(model, key)
        if obj is None:
            raise NotFound(f"No {model.__name__.lower()} {key}.")
        return obj

    def member(self, card_no: str) -> Member:
        member = self.session.scalar(select(Member).where(Member.card_no == card_no.strip().upper()))
        if member is None:
            raise NotFound(f"No member with card {card_no}.")
        return member

    def item(self, barcode: str) -> BookItem:
        item = self.session.get(BookItem, barcode.strip().upper())
        if item is None:
            raise NotFound(f"No copy has barcode {barcode}.")
        return item

    def search(self, q="", by="all", subject="", year_from=None, year_to=None, available=False,
               sort="title", limit=24, offset=0) -> tuple[int, list[Book]]:
        """Search the catalogue by title, author, subject and publication year (case study §1)."""
        stmt = select(Book)
        if q := q.strip():
            fields = {
                "title": [Book.title.icontains(q, autoescape=True)],
                "author": [Book.author.icontains(q, autoescape=True)],
                "isbn": [Book.isbn == q.replace("-", "")],
            }
            stmt = stmt.where(or_(*fields.get(by, [c for cs in fields.values() for c in cs])))
        if subject:
            stmt = stmt.where(Book.subject == subject)
        if year_from is not None:
            stmt = stmt.where(Book.year >= year_from)
        if year_to is not None:
            stmt = stmt.where(Book.year <= year_to)
        if available:
            stmt = stmt.where(Book.items.any(BookItem.status == ItemStatus.AVAILABLE))
        total = self.session.scalar(select(func.count()).select_from(stmt.subquery()))
        order = {"year": Book.year.asc(), "-year": Book.year.desc(), "new": Book.id.desc()}.get(sort, Book.title)
        page = stmt.order_by(order, Book.id).limit(limit).offset(offset)
        books = self.session.scalars(page.options(selectinload(Book.items), selectinload(Book.reservations)))
        return total, list(books)

    # circulation ------------------------------------------------------------------------------

    def issue(self, member: Member, item: BookItem) -> Loan:
        member.ensure_can_borrow()
        if any(loan.item.book is item.book for loan in member.active_loans):
            raise LibraryError(f"{member.name} already has a copy of “{item.book.title}”.")
        if item.status == ItemStatus.ON_HOLD:
            hold = self.session.scalar(select(Reservation).where(
                Reservation.barcode == item.barcode, Reservation.status == ReservationStatus.READY))
            if hold.member is not member:
                raise LibraryError(f"Copy {item.barcode} is on hold for {hold.member.name}.")
            hold.status = ReservationStatus.FULFILLED
        elif item.status != ItemStatus.AVAILABLE:
            raise LibraryError(f"Copy {item.barcode} is {item.status.replace('_', ' ')}.")
        for r in item.book.queue:  # a queued member who borrows a shelf copy leaves the queue
            if r.member is member:
                r.status = ReservationStatus.FULFILLED
        item.status = ItemStatus.LOANED
        loan = Loan(item=item, member=member, issued_on=self.today, renewals=0, overdue_notified=False,
                    due_on=self.today + timedelta(days=member.loan_days))
        self.session.add(loan)
        self._publish("issued", member=member, title=item.book.title, due=loan.due_on, barcode=item.barcode)
        return loan

    def return_item(self, item: BookItem) -> Loan:
        loan = item.current_loan
        if loan is None:
            raise LibraryError(f"Copy {item.barcode} is not on loan.")
        loan.returned_on = self.today
        member, title = loan.member, item.book.title
        self._publish("returned", member=member, title=title, barcode=item.barcode)
        if days := loan.days_overdue(self.today):
            fine = Fine(loan=loan, member=member, amount=days * member.fine_per_day, created_on=self.today)
            self.session.add(fine)
            self._publish("fine", member=member, amount=fine.amount, title=title, days=days)
        self._shelve(item)
        return loan

    def renew(self, loan: Loan, member: Member) -> Loan:
        if loan.member is not member or loan.returned_on:
            raise LibraryError("You can only renew your own current loans.")
        if loan.days_overdue(self.today):
            raise LibraryError("Overdue books can't be renewed. Please bring it back to the desk.")
        if loan.renewals >= self.MAX_RENEWALS:
            raise LibraryError("This loan has already been renewed once.")
        if loan.item.book.queue:
            raise LibraryError("Another member is waiting for this title, so it can't be renewed.")
        loan.due_on += timedelta(days=member.loan_days)
        loan.renewals += 1
        self._publish("renewed", member=member, title=loan.item.book.title, due=loan.due_on)
        return loan

    def reserve(self, member: Member, book: Book) -> Reservation:
        if not member.active:
            raise LibraryError("Your membership is suspended.")
        if book.count(ItemStatus.AVAILABLE):
            raise LibraryError(f"“{book.title}” is on the shelf, so there's no need to reserve it.")
        if any(r.book is book and r.status in ReservationStatus.OPEN for r in member.reservations):
            raise LibraryError(f"You have already reserved “{book.title}”.")
        if any(loan.item.book is book for loan in member.active_loans):
            raise LibraryError(f"You already have “{book.title}” on loan.")
        reservation = Reservation(book=book, member=member, status=ReservationStatus.WAITING, created_at=self.now)
        self.session.add(reservation)
        self._publish("reserved", member=member, title=book.title)
        return reservation

    def cancel(self, reservation: Reservation, member: Member) -> None:
        if reservation.member is not member or reservation.status not in ReservationStatus.OPEN:
            raise LibraryError("Only your open reservations can be cancelled.")
        was_holding = reservation.status == ReservationStatus.READY
        reservation.status = ReservationStatus.CANCELLED
        if was_holding:
            self._shelve(reservation.item)

    def collect(self, fine: Fine) -> Fine:
        if fine.paid_on:
            raise LibraryError("This fine is already paid.")
        fine.paid_on = self.today
        self._publish("fine_paid", member=fine.member, amount=fine.amount)
        return fine

    def _shelve(self, item: BookItem) -> None:
        """A copy is free again: hold it for the next member in the queue, or put it back on the shelf."""
        queue = item.book.queue
        if not queue:
            item.status = ItemStatus.AVAILABLE
            return
        nxt = queue[0]
        nxt.status, nxt.item = ReservationStatus.READY, item
        nxt.hold_until = self.today + timedelta(days=self.HOLD_DAYS)
        item.status = ItemStatus.ON_HOLD
        self._publish("reservation_ready", member=nxt.member, title=item.book.title, until=nxt.hold_until,
                      barcode=item.barcode)

    def sweep(self) -> None:
        """Time-based rules: overdue notices (once per loan) and holds that were never collected.

        Evaluated lazily on dashboard/account requests; move to a scheduled job once notices
        must reach people who aren't using the app (e.g. email).
        """
        overdue = self.session.scalars(select(Loan).where(
            Loan.returned_on.is_(None), Loan.due_on < self.today, Loan.overdue_notified.is_(False))).all()
        for loan in overdue:
            loan.overdue_notified = True
            self._publish("overdue", member=loan.member, title=loan.item.book.title, due=loan.due_on,
                          rate=loan.member.fine_per_day)
        expired = self.session.scalars(select(Reservation).where(
            Reservation.status == ReservationStatus.READY, Reservation.hold_until < self.today)).all()
        for reservation in expired:
            reservation.status = ReservationStatus.EXPIRED
            self._publish("hold_expired", member=reservation.member, title=reservation.book.title)
            self._shelve(reservation.item)

    # catalogue & membership ------------------------------------------------------------------

    def catalogue(self, book: Book, copies: int, rack: str) -> Book:
        if self.session.scalar(select(Book.id).where(Book.isbn == book.isbn)):
            raise LibraryError(f"ISBN {book.isbn} is already in the catalogue.")
        self.session.add(book)
        self.add_copies(book, copies, rack)
        self._publish("catalogued", title=book.title)
        return book

    def add_copies(self, book: Book, count: int, rack: str) -> list[BookItem]:
        last = self.session.scalar(select(func.max(BookItem.barcode)))
        start = int(last[2:]) + 1 if last else 1
        items = [BookItem(barcode=f"SM{start + n:06d}", book=book, rack=rack.strip().upper(),
                          status=ItemStatus.AVAILABLE, acquired_on=self.today) for n in range(count)]
        self.session.add_all(items)
        for item in items:  # a new copy may be exactly what someone is queued for
            self._shelve(item)
        return items

    def set_lost(self, item: BookItem, lost: bool) -> BookItem:
        if lost and item.status != ItemStatus.AVAILABLE:
            raise LibraryError(f"Only copies on the shelf can be written off; {item.barcode} is "
                               f"{item.status.replace('_', ' ')}.")
        if not lost and item.status != ItemStatus.LOST:
            raise LibraryError(f"Copy {item.barcode} isn't marked lost.")
        if lost:
            item.status = ItemStatus.LOST
        else:
            self._shelve(item)
        return item

    def register(self, kind: str, name: str, email: str, password: str) -> Member:
        member_cls = MEMBER_TYPES.get(kind)  # Factory: the membership type picks the class
        if member_cls is None:
            raise LibraryError(f"Unknown membership type “{kind}”.")
        email = email.strip().lower()
        if self.session.scalar(select(User.id).where(User.email == email)):
            raise LibraryError("That email is already registered.")
        # Known limit: max+1 card numbers can collide under concurrent sign-ups; the unique index rejects the loser.
        last = self.session.scalar(select(func.max(User.id))) or 0
        member = member_cls(name=name.strip(), email=email, card_no=f"LIB{10001 + last}", active=True,
                            joined_on=self.today)
        member.set_password(password)
        self.session.add(member)
        self._publish("joined", member=member)
        return member
