"""Business rules from the case study, exercised through the Library facade.  Run: python -m unittest"""
import unittest
from datetime import date, timedelta

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db import Base
from app.library import Library
from app.models import (
    Activity, Book, Faculty, ItemStatus, LibraryError, Notification, ReservationStatus, Student,
)

DAY0 = date(2026, 1, 5)


class LibraryTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.lib = Library(self.db, DAY0)
        self.ana = self.member(Student, "Ana")
        self.raj = self.member(Student, "Raj")
        self.kim = self.member(Faculty, "Kim")
        self.dune = self.book("Dune", "Frank Herbert", "Science Fiction", 1965, copies=1)
        self.emma = self.book("Emma", "Jane Austen", "Romance", 1815, copies=2)

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def member(self, cls, name):
        return self.lib.register(cls.__mapper__.polymorphic_identity, name, f"{name}@test.org", "password1")

    def book(self, title, author, subject, year, copies):
        isbn = str(9780000000000 + len(self.db.scalars(select(Book)).all()))
        return self.lib.catalogue(Book(isbn=isbn, title=title, author=author, subject=subject, year=year),
                                  copies, "R-01A")

    def on(self, days):
        """The library as it is `days` after DAY0."""
        return Library(self.db, DAY0 + timedelta(days=days))

    def test_policies_are_polymorphic(self):
        student_loan = self.lib.issue(self.ana, self.dune.items[0])
        faculty_loan = self.lib.issue(self.kim, self.emma.items[0])
        self.assertEqual(student_loan.due_on, DAY0 + timedelta(days=10))
        self.assertEqual(faculty_loan.due_on, DAY0 + timedelta(days=30))

    def test_students_hold_at_most_five_books(self):
        books = [self.book(f"Book {n}", "A. Writer", "Poetry", 2000, copies=1) for n in range(6)]
        for b in books[:5]:
            self.lib.issue(self.ana, b.items[0])
        with self.assertRaisesRegex(LibraryError, "at most 5"):
            self.lib.issue(self.ana, books[5].items[0])

    def test_one_copy_of_a_title_per_member(self):
        self.lib.issue(self.ana, self.emma.items[0])
        with self.assertRaisesRegex(LibraryError, "already has a copy"):
            self.lib.issue(self.ana, self.emma.items[1])

    def test_late_return_raises_fine_that_blocks_borrowing_until_paid(self):
        loan = self.lib.issue(self.ana, self.dune.items[0])
        self.on(13).return_item(loan.item)  # due day 10, back day 13
        self.assertEqual(loan.fine.amount, 3 * Student.fine_per_day)
        with self.assertRaisesRegex(LibraryError, "unpaid fines"):
            self.on(13).issue(self.ana, self.emma.items[0])
        self.on(14).collect(loan.fine)
        self.on(14).issue(self.ana, self.emma.items[0])

    def test_on_time_return_has_no_fine_and_reshelves(self):
        loan = self.lib.issue(self.ana, self.dune.items[0])
        self.on(10).return_item(loan.item)
        self.assertIsNone(loan.fine)
        self.assertEqual(loan.item.status, ItemStatus.AVAILABLE)

    def test_reserve_only_when_no_copy_is_on_the_shelf(self):
        with self.assertRaisesRegex(LibraryError, "on the shelf"):
            self.lib.reserve(self.raj, self.dune)
        self.lib.issue(self.ana, self.dune.items[0])
        self.lib.reserve(self.raj, self.dune)
        with self.assertRaisesRegex(LibraryError, "already reserved"):
            self.lib.reserve(self.raj, self.dune)

    def test_returned_copy_is_held_for_the_first_in_queue(self):
        copy = self.dune.items[0]
        self.lib.issue(self.ana, copy)
        first = self.lib.reserve(self.raj, self.dune)
        second = self.lib.reserve(self.kim, self.dune)
        self.on(5).return_item(copy)
        self.assertEqual((copy.status, first.status, second.status),
                         (ItemStatus.ON_HOLD, ReservationStatus.READY, ReservationStatus.WAITING))
        with self.assertRaisesRegex(LibraryError, "on hold for Raj"):
            self.on(5).issue(self.kim, copy)
        self.on(6).issue(self.raj, copy)
        self.assertEqual(first.status, ReservationStatus.FULFILLED)

    def test_uncollected_hold_expires_and_passes_down_the_queue(self):
        copy = self.dune.items[0]
        self.lib.issue(self.ana, copy)
        first = self.lib.reserve(self.raj, self.dune)
        second = self.lib.reserve(self.kim, self.dune)
        self.on(5).return_item(copy)  # held for Raj until day 8
        self.on(9).sweep()
        self.assertEqual(first.status, ReservationStatus.EXPIRED)
        self.assertEqual(second.status, ReservationStatus.READY)
        self.assertIs(second.item, copy)

    def test_renewal_rules(self):
        loan = self.lib.issue(self.ana, self.emma.items[0])
        self.on(3).renew(loan, self.ana)
        self.assertEqual(loan.due_on, DAY0 + timedelta(days=20))
        with self.assertRaisesRegex(LibraryError, "already been renewed"):
            self.on(4).renew(loan, self.ana)

        late = self.lib.issue(self.ana, self.dune.items[0])
        with self.assertRaisesRegex(LibraryError, "Overdue"):
            self.on(11).renew(late, self.ana)

    def test_no_renewal_while_someone_waits(self):
        loan = self.lib.issue(self.ana, self.dune.items[0])
        self.lib.reserve(self.raj, self.dune)
        with self.assertRaisesRegex(LibraryError, "waiting"):
            self.on(2).renew(loan, self.ana)

    def test_overdue_notice_is_sent_once(self):
        self.lib.issue(self.ana, self.dune.items[0])
        self.on(11).sweep()
        self.on(12).sweep()
        notices = self.db.scalars(select(Notification).where(Notification.kind == "overdue")).all()
        self.assertEqual(len(notices), 1)
        self.assertIs(notices[0].user, self.ana)

    def test_observers_record_notifications_and_activity(self):
        self.lib.issue(self.ana, self.dune.items[0])
        self.db.flush()
        kinds = {n.kind for n in self.ana.notifications}
        self.assertIn("issued", kinds)
        feed = [a.message for a in self.db.scalars(select(Activity))]
        self.assertTrue(any("Ana borrowed “Dune”" in m for m in feed))

    def test_suspended_member_cannot_borrow_or_reserve(self):
        self.ana.active = False
        with self.assertRaisesRegex(LibraryError, "suspended"):
            self.lib.issue(self.ana, self.emma.items[0])
        self.lib.issue(self.raj, self.dune.items[0])
        with self.assertRaisesRegex(LibraryError, "suspended"):
            self.lib.reserve(self.ana, self.dune)

    def test_lost_copies_and_new_copies_serve_the_queue(self):
        copy = self.dune.items[0]
        self.lib.issue(self.ana, copy)
        reservation = self.lib.reserve(self.raj, self.dune)
        [new] = self.lib.add_copies(self.dune, 1, "R-02B")
        self.assertEqual((new.status, reservation.status), (ItemStatus.ON_HOLD, ReservationStatus.READY))
        with self.assertRaisesRegex(LibraryError, "Only copies on the shelf"):
            self.lib.set_lost(copy, True)

    def test_search_by_title_author_isbn_subject_and_year(self):
        def titles(**kw):
            return [b.title for b in self.lib.search(**kw)[1]]
        self.assertEqual(titles(q="dun", by="title"), ["Dune"])
        self.assertEqual(titles(q="austen", by="author"), ["Emma"])
        self.assertEqual(titles(q=self.emma.isbn, by="isbn"), ["Emma"])
        self.assertEqual(titles(subject="Science Fiction"), ["Dune"])
        self.assertEqual(titles(year_from=1900), ["Dune"])
        self.lib.issue(self.ana, self.dune.items[0])
        self.assertEqual(titles(available=True), ["Emma"])

    def test_registration_rejects_duplicate_email_and_unknown_type(self):
        with self.assertRaisesRegex(LibraryError, "already registered"):
            self.lib.register("student", "Ana Two", "ANA@test.org", "password1")
        with self.assertRaisesRegex(LibraryError, "Unknown membership"):
            self.lib.register("pirate", "Jack", "jack@test.org", "password1")

    def test_passwords_are_salted_and_checked(self):
        self.assertTrue(self.ana.check_password("password1"))
        self.assertFalse(self.ana.check_password("password2"))
        self.assertNotEqual(self.ana.password_hash, self.raj.password_hash)


if __name__ == "__main__":
    unittest.main()
