"""Demo data: the curated catalogue plus two months of circulation replayed through the real Library facade."""
import itertools
import json
import random
from datetime import date, time, timedelta
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .library import Library
from .models import (
    Book, BookItem, Faculty, ItemStatus, Librarian, LibraryError, Member, Reservation, ReservationStatus, Student,
    User, hash_password,
)

DATA = Path(__file__).resolve().parent.parent / "data" / "books.json"
PASSWORD = "shelfmark"  # every demo member
STAFF_PASSWORD = "shelfmark-admin"  # the demo librarian, who signs in to Shelfmark Admin as STAFF001
RACKS = {
    "Fantasy": "FAN", "Science Fiction": "SCI", "Mystery": "MYS", "Romance": "ROM", "Horror": "HOR",
    "Historical Fiction": "HFI", "Poetry": "POE", "Biography": "BIO", "History": "HIS", "Science": "SCN",
    "Philosophy": "PHI", "Programming": "PRG", "Indian Fiction": "IND", "Young Adult": "YAD", "Graphic Novels": "GRA",
    "Psychology": "PSY", "Business": "BUS", "Self-Help": "SLF",
}
NAMES = [
    "Aarav Mehta", "Diya Kapoor", "Kabir Singh", "Meera Nair", "Rohan Das", "Isha Verma", "Arjun Reddy",
    "Saanvi Iyer", "Vihaan Gupta", "Anika Joshi", "Reyansh Bose", "Myra Pillai", "Aditya Rao", "Kiara Shah",
    "Ishaan Malhotra", "Tara Menon", "Dev Chatterjee", "Nisha Agarwal", "Yash Kulkarni", "Riya Banerjee",
    "Omar Sheikh", "Zara Khan", "Liam Fernandes", "Sara Thomas", "Neil D'Souza", "Pooja Hegde", "Karan Batra",
    "Aisha Siddiqui", "Varun Tiwari", "Ananya Ghosh", "Nikhil Jain", "Priya Sen", "Siddharth Rao",
    "Fatima Ali", "Rahul Mishra", "Leah George", "Arnav Saxena", "Ishita Chawla", "Manav Bhatt", "Sneha Patil",
    "Harsh Vardhan", "Kavya Reddy", "Aryan Kapoor", "Mehak Arora", "Rudra Pandey", "Tanvi Deshmukh", "Samar Qureshi",
    "Navya Krishnan", "Pranav Hegde", "Jiya Bhalla", "Kunal Sethi", "Avni Mathur", "Dhruv Ahuja", "Simran Kaur",
    "Arjun Nambiar", "Ira Dutta", "Vivaan Sood", "Prisha Goyal", "Ayaan Mirza", "Diya Fernandes",
]


def seed(db: Session, today: date | None = None) -> None:
    if db.scalar(select(func.count(User.id))):
        return
    today = today or date.today()
    rng = random.Random(42)
    books = _catalogue(db, rng, today - timedelta(days=120))
    librarian, student, faculty, members = _people(db, rng, today)
    _simulate(db, rng, books, members, today, days=60)
    _demo_accounts(db, rng, books, student, faculty, members, today)
    Library(db, today).sweep()
    db.commit()


def _catalogue(db, rng, acquired):
    books, barcodes = [], itertools.count(1)
    position = {code: 0 for code in RACKS.values()}
    for row in json.loads(DATA.read_text(encoding="utf-8")):
        book = Book(**row, added_on=acquired)
        code = RACKS[book.subject]
        rack = f"{code}-{position[code] // 3 + 1:02d}{'ABC'[position[code] % 3]}"  # aisle, bay, shelf
        position[code] += 1
        for _ in range(rng.choice([1, 1, 2, 2, 2, 3, 3, 4])):
            book.items.append(BookItem(barcode=f"SM{next(barcodes):06d}", rack=rack,
                                       status=ItemStatus.AVAILABLE, acquired_on=acquired))
        db.add(book)
        books.append(book)
    db.flush()
    return books


def _people(db, rng, today):
    pw = hash_password(PASSWORD)  # one hash shared by the demo accounts keeps seeding fast

    def person(cls, name, email, card, joined):
        user = cls(name=name, email=email, card_no=card, password_hash=pw, active=True, joined_on=joined)
        db.add(user)
        return user

    librarian = person(Librarian, "Rohan Iyer", "librarian@shelfmark.test", "STAFF001", today - timedelta(days=400))
    librarian.set_password(STAFF_PASSWORD)
    student = person(Student, "Ananya Rao", "student@shelfmark.test", "LIB10001", today - timedelta(days=200))
    faculty = person(Faculty, "Dr. Kavita Menon", "faculty@shelfmark.test", "LIB10002", today - timedelta(days=300))
    members = []
    for n, name in enumerate(NAMES, start=3):
        cls = Faculty if n % 5 == 0 else Student
        email = name.lower().replace(" ", ".").replace("'", "") + "@shelfmark.test"
        members.append(person(cls, name, email, f"LIB{10000 + n}", today - timedelta(days=rng.randint(3, 360))))
    db.flush()
    return librarian, student, faculty, members


def _simulate(db, rng, books, members, today, days):
    """Walk-ins borrow popular titles, some come back late, queues form and holds get collected or expire."""
    weights = [rng.random() ** 2 + (0.6 if b.subject in ("Fantasy", "Science Fiction", "Mystery", "Programming", "Young Adult", "Self-Help")
                                     else 0) for b in books]
    plans = {}  # loan -> day the borrower will bring it back
    for back in range(days, 0, -1):
        day = today - timedelta(days=back)
        lib = Library(db, day)
        lib.clock = time(9, 30)
        for loan, when in list(plans.items()):
            if when == day:
                lib.clock = _later(rng, lib.clock)
                lib.return_item(loan.item)
                del plans[loan]
        ready = db.scalars(select(Reservation).where(Reservation.status == ReservationStatus.READY)).all()
        for hold in ready:
            lib.clock = _later(rng, lib.clock)
            if rng.random() < 0.5:
                _try(lambda: plans.update({lib.issue(hold.member, hold.item): _plan(rng, day, hold.member)}))
        for member in members:
            if member.fines_due and rng.random() < 0.3:
                for fine in member.fines:
                    if not fine.paid_on:
                        lib.collect(fine)
        for _ in range(rng.randint(4, 10)):
            lib.clock = _later(rng, lib.clock)
            member, book = rng.choice(members), rng.choices(books, weights)[0]
            copy = next((i for i in book.items if i.status == ItemStatus.AVAILABLE), None)
            if copy:
                _try(lambda: plans.update({lib.issue(member, copy): _plan(rng, day, member)}))
            elif rng.random() < 0.4:
                _try(lambda: lib.reserve(member, book))
        lib.sweep()
        db.flush()


def _demo_accounts(db, rng, books, student, faculty, members, today):
    """Give the demo logins a story: a late return, a loan running, one overdue, a hold ready, one queued."""
    def at(back):
        lib = Library(db, today - timedelta(days=back))
        lib.clock = time(rng.randint(10, 18), rng.randint(0, 59))
        return lib

    def free(exclude=()):
        pool = [b for b in books if b.count(ItemStatus.AVAILABLE) and b not in exclude]
        return rng.choice(pool)

    def single_copy_free(exclude):
        return next(b for b in sorted(books, key=lambda b: rng.random())
                    if len(b.items) == 1 and b.items[0].status == ItemStatus.AVAILABLE and b not in exclude)

    def lend_to_someone(lib, book):
        for member in rng.sample(members, len(members)):
            if _try(lambda: lib.issue(member, book.items[0])):
                return

    by_title = {b.title: b for b in books}
    picks = []
    for title in ("The Hobbit", "Clean Code", "Dune", "Design Patterns: Elements of Reusable Object-Oriented Software"):
        book = by_title.get(title)
        picks.append(book if book and book.count(ItemStatus.AVAILABLE) and book not in picks else free(picks))

    old = at(32).issue(student, _copy(picks[0]))
    at(17).return_item(old.item)  # 5 days late -> fine
    at(16).collect(old.fine)
    at(12).issue(student, _copy(picks[1]))  # due 2 days ago -> overdue
    at(3).issue(student, _copy(picks[2]))
    at(20).issue(faculty, _copy(picks[3]))
    at(6).issue(faculty, _copy(free(picks)))

    held = single_copy_free(picks)
    queued = single_copy_free(picks + [held])
    lend_to_someone(at(9), held)
    at(4).reserve(student, held)
    at(1).return_item(held.items[0])  # copy comes back -> held for the student
    lend_to_someone(at(5), queued)
    at(2).reserve(student, queued)
    db.flush()


def _later(rng, clock):
    """Advance the replay clock by a few minutes, never past closing time."""
    minutes = min(clock.hour * 60 + clock.minute + rng.randint(4, 55), 20 * 60 + 45)
    return time(minutes // 60, minutes % 60)


def _copy(book):
    return next(i for i in book.items if i.status == ItemStatus.AVAILABLE)


def _plan(rng, day, member: Member):
    return day + timedelta(days=rng.randint(2, member.loan_days + 3))


def _try(action):
    try:
        return action() or True
    except LibraryError:
        return False
