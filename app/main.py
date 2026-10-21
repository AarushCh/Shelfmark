"""HTTP layer: a JSON API plus the three static apps. The rules live in library.py and models.py."""
import os
from contextlib import asynccontextmanager
from datetime import date, timedelta
from pathlib import Path
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import desc, func, or_, select, update
from sqlalchemy.orm import Session, selectinload
from starlette.middleware.sessions import SessionMiddleware

from .db import Base, SessionLocal, engine
from .library import Library
from .models import (
    Activity, Book, BookItem, Fine, ItemStatus, Librarian, LibraryError, Loan, Member, NotFound, Notification,
    Reservation, ReservationStatus, User,
)
from .seed import seed

WEB = Path(__file__).resolve().parent.parent / "web"
ON_RENDER = "RENDER" in os.environ
SECRET_KEY = os.environ.get("SECRET_KEY") or ("" if ON_RENDER else "local-dev-only")
if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY must be set in production")


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(engine)  # No migrations yet; add Alembic once a deployed schema has to change
    with SessionLocal() as db:
        seed(db)
    yield


app = FastAPI(title="Shelfmark", summary="Library management system API", lifespan=lifespan)
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY, session_cookie="shelfmark", max_age=14 * 24 * 3600,
                   same_site="lax", https_only=ON_RENDER)


@app.exception_handler(LibraryError)
def rule_broken(_: Request, exc: LibraryError):
    return JSONResponse({"detail": str(exc)}, status_code=404 if isinstance(exc, NotFound) else 409)


# dependencies ---------------------------------------------------------------------------------

def get_db():
    with SessionLocal() as db:
        yield db


DB = Annotated[Session, Depends(get_db)]


def current_user(request: Request, db: DB) -> User | None:
    uid = request.session.get("uid")
    return db.get(User, uid) if uid else None


def require(role: type[User]):
    def guard(user: Annotated[User | None, Depends(current_user)]):
        if user is None:
            raise HTTPException(401, "Please sign in first.")
        if not isinstance(user, role):
            raise HTTPException(403, f"That needs a {role.label.lower()} account.")
        return user
    return guard


CurrentMember = Annotated[Member, Depends(require(Member))]
CurrentLibrarian = Annotated[Librarian, Depends(require(Librarian))]


def number(db: Session, stmt) -> int:
    return db.scalar(stmt) or 0


# JSON shapes ------------------------------------------------------------------------------------

def brief(book: Book) -> dict:
    return {"id": book.id, "title": book.title, "author": book.author, "subject": book.subject,
            "cover_id": book.cover_id}


def book_json(book: Book, detail: bool = False) -> dict:
    data = brief(book) | {
        "isbn": book.isbn, "publisher": book.publisher, "year": book.year, "pages": book.pages,
        "description": book.description,
        "copies": sum(i.status != ItemStatus.LOST for i in book.items),
        "available": book.count(ItemStatus.AVAILABLE), "queue": len(book.queue),
    }
    if detail:
        data["items"] = [{"barcode": i.barcode, "rack": i.rack, "status": i.status,
                          "due_on": loan.due_on if (loan := i.current_loan) else None} for i in book.items]
    return data


def user_json(user: User) -> dict:
    data = {"id": user.id, "name": user.name, "email": user.email, "card_no": user.card_no, "role": user.role,
            "label": user.label, "active": user.active, "joined_on": user.joined_on}
    if isinstance(user, Member):
        data |= {"max_books": user.max_books, "loan_days": user.loan_days, "fine_per_day": user.fine_per_day}
    return data


def person(member: Member) -> dict:
    return {"id": member.id, "name": member.name, "card_no": member.card_no, "label": member.label}


def loan_json(loan: Loan, today: date) -> dict:
    late = loan.days_overdue(today)
    return {"id": loan.id, "barcode": loan.barcode, "book": brief(loan.item.book), "member": person(loan.member),
            "issued_on": loan.issued_on, "due_on": loan.due_on, "returned_on": loan.returned_on,
            "renewals": loan.renewals, "days_overdue": late,
            "accruing": late * loan.member.fine_per_day if loan.returned_on is None else 0,
            "fine": loan.fine.amount if loan.fine else None}


def reservation_json(r: Reservation) -> dict:
    return {"id": r.id, "status": r.status, "book": brief(r.book), "member": person(r.member),
            "created_at": r.created_at, "barcode": r.barcode, "hold_until": r.hold_until,
            "position": r.book.queue.index(r) + 1 if r.status == ReservationStatus.WAITING else None}


def fine_json(fine: Fine) -> dict:
    return {"id": fine.id, "amount": fine.amount, "created_on": fine.created_on, "paid_on": fine.paid_on,
            "book": brief(fine.loan.item.book), "member": person(fine.member),
            "days": fine.loan.days_overdue(fine.created_on)}


# public ----------------------------------------------------------------------------------------

@app.get("/api/health", include_in_schema=False)
def health(db: DB):
    db.execute(select(1))
    return {"ok": True}


@app.get("/api/stats", summary="Catalogue figures for the landing page and subject browser")
def stats(db: DB):
    loans_per_book = (select(BookItem.book_id, func.count(Loan.id).label("n"))
                      .join(Loan, Loan.barcode == BookItem.barcode).group_by(BookItem.book_id).subquery())
    popularity = func.coalesce(loans_per_book.c.n, 0)
    ranked = (select(Book, popularity).outerjoin(loans_per_book, loans_per_book.c.book_id == Book.id)
              .order_by(popularity.desc(), Book.title).options(selectinload(Book.items), selectinload(Book.reservations)))
    rows = db.execute(ranked).all()
    books = [book for book, _ in rows]
    subjects = {}
    for book, loans in rows:
        s = subjects.setdefault(book.subject, {"name": book.subject, "titles": 0, "available": 0, "loans": 0, "top": []})
        s["titles"] += 1
        s["available"] += book.count(ItemStatus.AVAILABLE)
        s["loans"] += loans
        if len(s["top"]) < 6:
            s["top"].append(brief(book))
    return {
        "titles": len(books),
        "copies": number(db, select(func.count()).where(BookItem.status != ItemStatus.LOST)),
        "available": number(db, select(func.count()).where(BookItem.status == ItemStatus.AVAILABLE)),
        "members": number(db, select(func.count(Member.id)).where(Member.active)),
        "on_loan": number(db, select(func.count(Loan.id)).where(Loan.returned_on.is_(None))),
        "loans": number(db, select(func.count(Loan.id))),
        "subjects": sorted(subjects.values(), key=lambda s: s["name"]),
        "popular": [book_json(b) for b in books[:6]],
    }


@app.get("/api/books", summary="Search the catalogue by title, author, ISBN, subject and publication year")
def search_books(
    db: DB, q: str = "", by: Literal["all", "title", "author", "isbn"] = "all", subject: str = "",
    year_from: int | None = None, year_to: int | None = None, available: bool = False,
    sort: Literal["title", "year", "-year", "new"] = "title",
    limit: Annotated[int, Query(ge=1, le=100)] = 24, offset: Annotated[int, Query(ge=0)] = 0,
):
    total, books = Library(db).search(q, by, subject, year_from, year_to, available, sort, limit, offset)
    return {"total": total, "items": [book_json(b) for b in books]}


@app.get("/api/books/{book_id}", summary="A title with each copy's rack, status and due date")
def get_book(book_id: int, db: DB):
    return book_json(Library(db).get(Book, book_id), detail=True)


# accounts --------------------------------------------------------------------------------------

class Credentials(BaseModel):
    email: str = Field(max_length=160)
    password: str = Field(max_length=128)


class SignUp(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=160)
    password: str = Field(min_length=8, max_length=128)


@app.post("/api/auth/login")
def login(body: Credentials, request: Request, db: DB):
    user = db.scalar(select(User).where(User.email == body.email.strip().lower()))
    if user is None or not user.check_password(body.password):
        raise HTTPException(401, "Wrong email or password.")
    request.session["uid"] = user.id
    return user_json(user)


@app.post("/api/auth/register", status_code=201, summary="Self sign-up (creates a student membership)")
def register(body: SignUp, request: Request, db: DB):
    member = Library(db).register("student", body.name, body.email, body.password)
    db.commit()
    request.session["uid"] = member.id
    return user_json(member)


@app.post("/api/auth/logout")
def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@app.get("/api/auth/me")
def whoami(user: Annotated[User | None, Depends(current_user)]):
    return user_json(user) if user else None


# member ---------------------------------------------------------------------------------------

@app.get("/api/me", summary="Everything on the signed-in member's account")
def my_account(member: CurrentMember, db: DB):
    lib = Library(db)
    lib.sweep()
    db.commit()
    notes = sorted(member.notifications, key=lambda n: n.id, reverse=True)
    return {
        "user": user_json(member),
        "loans": [loan_json(loan, lib.today) for loan in member.loans[:40]],
        "reservations": [reservation_json(r) for r in member.reservations[:20]],
        "fines": [fine_json(f) for f in member.fines],
        "fines_due": member.fines_due,
        "notifications": [{"id": n.id, "kind": n.kind, "message": n.message, "created_at": n.created_at,
                           "read": n.read} for n in notes[:30]],
        "unread": sum(not n.read for n in notes),
    }


@app.post("/api/me/notifications/read")
def mark_notifications_read(member: CurrentMember, db: DB):
    db.execute(update(Notification).where(Notification.user_id == member.id).values(read=True))
    db.commit()
    return {"ok": True}


@app.post("/api/books/{book_id}/reserve", status_code=201, summary="Join the queue for a title with no copy free")
def reserve(book_id: int, member: CurrentMember, db: DB):
    lib = Library(db)
    reservation = lib.reserve(member, lib.get(Book, book_id))
    db.commit()
    return reservation_json(reservation)


@app.post("/api/reservations/{reservation_id}/cancel")
def cancel_reservation(reservation_id: int, member: CurrentMember, db: DB):
    lib = Library(db)
    lib.cancel(lib.get(Reservation, reservation_id), member)
    db.commit()
    return {"ok": True}


@app.post("/api/loans/{loan_id}/renew")
def renew(loan_id: int, member: CurrentMember, db: DB):
    lib = Library(db)
    loan = lib.renew(lib.get(Loan, loan_id), member)
    db.commit()
    return loan_json(loan, lib.today)


# circulation desk (librarian) -----------------------------------------------------------------

class CardAndCopy(BaseModel):
    card_no: str = Field(min_length=1, max_length=20)
    barcode: str = Field(min_length=1, max_length=20)


class Copy(BaseModel):
    barcode: str = Field(min_length=1, max_length=20)


class NewBook(BaseModel):
    isbn: str = Field(pattern=r"^(\d{9}[\dX]|\d{13})$")
    title: str = Field(min_length=1, max_length=300)
    author: str = Field(min_length=1, max_length=200)
    subject: str = Field(min_length=1, max_length=60)
    publisher: str | None = Field(None, max_length=200)
    year: int | None = Field(None, ge=-3000, le=2100)
    pages: int | None = Field(None, ge=1, le=20000)
    cover_id: int | None = None
    description: str | None = Field(None, max_length=4000)
    copies: int = Field(1, ge=1, le=20)
    rack: str = Field(min_length=1, max_length=20)


class BookChanges(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=300)
    author: str | None = Field(None, min_length=1, max_length=200)
    subject: str | None = Field(None, min_length=1, max_length=60)
    publisher: str | None = Field(None, max_length=200)
    year: int | None = Field(None, ge=-3000, le=2100)
    pages: int | None = Field(None, ge=1, le=20000)
    description: str | None = Field(None, max_length=4000)


class NewCopies(BaseModel):
    count: int = Field(1, ge=1, le=20)
    rack: str = Field(min_length=1, max_length=20)


class CopyChanges(BaseModel):
    lost: bool


class NewMember(SignUp):
    kind: Literal["student", "faculty"]


class MemberChanges(BaseModel):
    active: bool


@app.get("/api/desk/overview", summary="Dashboard: KPIs, 14-day circulation, overdue list, holds, activity")
def overview(_: CurrentLibrarian, db: DB):
    lib = Library(db)
    lib.sweep()
    db.commit()
    today = lib.today
    items = dict(db.execute(select(BookItem.status, func.count()).group_by(BookItem.status)).all())
    open_loans = Loan.returned_on.is_(None)
    since = today - timedelta(days=13)
    issued = dict(db.execute(select(Loan.issued_on, func.count()).where(Loan.issued_on >= since)
                             .group_by(Loan.issued_on)).all())
    returned = dict(db.execute(select(Loan.returned_on, func.count()).where(Loan.returned_on >= since)
                               .group_by(Loan.returned_on)).all())
    month = today - timedelta(days=30)
    back_month = number(db, select(func.count(Loan.id)).where(Loan.returned_on >= month))
    on_time = number(db, select(func.count(Loan.id)).where(Loan.returned_on >= month, Loan.returned_on <= Loan.due_on))
    by_subject = db.execute(select(Book.subject, func.count(Loan.id)).join(BookItem, BookItem.book_id == Book.id)
                            .join(Loan, Loan.barcode == BookItem.barcode).where(open_loans)
                            .group_by(Book.subject).order_by(func.count(Loan.id).desc())).all()
    overdue = db.scalars(select(Loan).where(open_loans, Loan.due_on < today).order_by(Loan.due_on).limit(8)).all()
    holds = db.scalars(select(Reservation).where(Reservation.status == ReservationStatus.READY)
                       .order_by(Reservation.hold_until)).all()
    activity = db.scalars(select(Activity).order_by(Activity.at.desc(), Activity.id.desc()).limit(16)).all()
    copies = sum(n for status, n in items.items() if status != ItemStatus.LOST)
    return {
        "today": today,
        "titles": number(db, select(func.count(Book.id))),
        "copies": copies,
        "items": items,
        "members": number(db, select(func.count(Member.id)).where(Member.active)),
        "new_members": number(db, select(func.count(Member.id)).where(Member.joined_on >= month)),
        "on_loan": number(db, select(func.count(Loan.id)).where(open_loans)),
        "overdue_count": number(db, select(func.count(Loan.id)).where(open_loans, Loan.due_on < today)),
        "waiting": number(db, select(func.count(Reservation.id)).where(Reservation.status == ReservationStatus.WAITING)),
        "fines_due": number(db, select(func.sum(Fine.amount)).where(Fine.paid_on.is_(None))),
        "fines_collected": number(db, select(func.sum(Fine.amount)).where(Fine.paid_on >= month)),
        "on_time_rate": round(100 * on_time / back_month) if back_month else 100,
        "series": [{"day": d, "issued": issued.get(d, 0), "returned": returned.get(d, 0)}
                   for d in (since + timedelta(days=i) for i in range(14))],
        "by_subject": [{"subject": s, "loans": n} for s, n in by_subject],
        "overdue": [loan_json(loan, today) for loan in overdue],
        "holds": [reservation_json(r) for r in holds],
        "activity": [{"at": a.at, "kind": a.kind, "message": a.message} for a in activity],
    }


@app.get("/api/desk/loans")
def list_loans(_: CurrentLibrarian, db: DB, status: Literal["active", "overdue", "returned"] = "active",
               q: str = "", limit: Annotated[int, Query(ge=1, le=200)] = 60):
    today = date.today()
    stmt = select(Loan).join(Loan.member).join(Loan.item).join(BookItem.book)
    stmt = {
        "active": stmt.where(Loan.returned_on.is_(None)).order_by(Loan.due_on),
        "overdue": stmt.where(Loan.returned_on.is_(None), Loan.due_on < today).order_by(Loan.due_on),
        "returned": stmt.where(Loan.returned_on.is_not(None)).order_by(Loan.returned_on.desc(), Loan.id.desc()),
    }[status]
    if q := q.strip():
        stmt = stmt.where(or_(Member.name.icontains(q, autoescape=True), Member.card_no == q.upper(),
                              Book.title.icontains(q, autoescape=True), Loan.barcode == q.upper()))
    return [loan_json(loan, today) for loan in db.scalars(stmt.limit(limit))]


@app.get("/api/desk/members")
def list_members(_: CurrentLibrarian, db: DB, q: str = "", limit: Annotated[int, Query(ge=1, le=200)] = 100):
    stmt = select(Member).options(selectinload(Member.loans), selectinload(Member.fines)).order_by(Member.name)
    if q := q.strip():
        stmt = stmt.where(or_(Member.name.icontains(q, autoescape=True), Member.email.icontains(q, autoescape=True),
                              Member.card_no == q.upper()))
    return [user_json(m) | {"on_loan": len(m.active_loans), "fines_due": m.fines_due,
                            "overdue": sum(loan.due_on < date.today() for loan in m.active_loans)}
            for m in db.scalars(stmt.limit(limit))]


@app.get("/api/desk/members/{card_no}", summary="A member's card: loans, reservations, fines")
def member_card(card_no: str, _: CurrentLibrarian, db: DB):
    lib = Library(db)
    member = lib.member(card_no)
    return {"user": user_json(member), "fines_due": member.fines_due,
            "loans": [loan_json(loan, lib.today) for loan in member.loans[:30]],
            "reservations": [reservation_json(r) for r in member.reservations[:20]],
            "fines": [fine_json(f) for f in member.fines]}


@app.post("/api/desk/members", status_code=201, summary="Register a student or faculty member")
def add_member(body: NewMember, _: CurrentLibrarian, db: DB):
    member = Library(db).register(body.kind, body.name, body.email, body.password)
    db.commit()
    return user_json(member)


@app.patch("/api/desk/members/{member_id}", summary="Suspend or reinstate a membership")
def change_member(member_id: int, body: MemberChanges, _: CurrentLibrarian, db: DB):
    member = Library(db).get(Member, member_id)
    member.active = body.active
    db.commit()
    return user_json(member)


@app.get("/api/desk/items/{barcode}", summary="Scan a copy: its title, rack, status, loan and hold")
def scan_copy(barcode: str, _: CurrentLibrarian, db: DB):
    lib = Library(db)
    item = lib.item(barcode)
    loan = item.current_loan
    hold = db.scalar(select(Reservation).where(Reservation.barcode == item.barcode,
                                               Reservation.status == ReservationStatus.READY))
    return {"barcode": item.barcode, "rack": item.rack, "status": item.status, "book": book_json(item.book),
            "loan": loan_json(loan, lib.today) if loan else None, "hold": reservation_json(hold) if hold else None}


@app.post("/api/desk/books", status_code=201, summary="Catalogue a new title with its copies")
def add_book(body: NewBook, _: CurrentLibrarian, db: DB):
    book = Book(**body.model_dump(exclude={"copies", "rack"}))
    Library(db).catalogue(book, body.copies, body.rack)
    db.commit()
    return book_json(book, detail=True)


@app.patch("/api/desk/books/{book_id}")
def change_book(book_id: int, body: BookChanges, _: CurrentLibrarian, db: DB):
    book = Library(db).get(Book, book_id)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(book, field, value)
    db.commit()
    return book_json(book, detail=True)


@app.post("/api/desk/books/{book_id}/copies", status_code=201)
def add_copies(book_id: int, body: NewCopies, _: CurrentLibrarian, db: DB):
    lib = Library(db)
    book = lib.get(Book, book_id)
    lib.add_copies(book, body.count, body.rack)
    db.commit()
    return book_json(book, detail=True)


@app.patch("/api/desk/items/{barcode}", summary="Write a copy off as lost, or put a found one back")
def change_copy(barcode: str, body: CopyChanges, _: CurrentLibrarian, db: DB):
    lib = Library(db)
    item = lib.set_lost(lib.item(barcode), body.lost)
    db.commit()
    return {"barcode": item.barcode, "status": item.status}


@app.post("/api/desk/issue", status_code=201, summary="Check a copy out to a member")
def issue(body: CardAndCopy, _: CurrentLibrarian, db: DB):
    lib = Library(db)
    loan = lib.issue(lib.member(body.card_no), lib.item(body.barcode))
    db.commit()
    return loan_json(loan, lib.today)


@app.post("/api/desk/return", summary="Check a copy back in; raises a fine if it is late")
def check_in(body: Copy, _: CurrentLibrarian, db: DB):
    lib = Library(db)
    item = lib.item(body.barcode)
    loan = lib.return_item(item)
    db.commit()
    return loan_json(loan, lib.today) | {"next": item.status}


@app.get("/api/desk/reservations")
def list_reservations(_: CurrentLibrarian, db: DB, status: Literal["waiting", "ready", "closed"] = "waiting"):
    closed = (ReservationStatus.FULFILLED, ReservationStatus.CANCELLED, ReservationStatus.EXPIRED)
    where = Reservation.status.in_(closed) if status == "closed" else Reservation.status == status
    order = desc(Reservation.id) if status == "closed" else Reservation.id
    return [reservation_json(r) for r in db.scalars(select(Reservation).where(where).order_by(order).limit(100))]


@app.get("/api/desk/fines")
def list_fines(_: CurrentLibrarian, db: DB, status: Literal["unpaid", "paid"] = "unpaid"):
    where = Fine.paid_on.is_(None) if status == "unpaid" else Fine.paid_on.is_not(None)
    return [fine_json(f) for f in db.scalars(select(Fine).where(where).order_by(Fine.id.desc()).limit(100))]


@app.post("/api/desk/fines/{fine_id}/pay", summary="Record a fine paid at the desk")
def collect_fine(fine_id: int, _: CurrentLibrarian, db: DB):
    lib = Library(db)
    fine = lib.collect(lib.get(Fine, fine_id))
    db.commit()
    return fine_json(fine)


# pages ------------------------------------------------------------------------------------------

@app.get("/catalog", include_in_schema=False)
def catalog_page():
    return FileResponse(WEB / "catalog.html")


@app.get("/desk", include_in_schema=False)
def desk_page():
    return FileResponse(WEB / "desk.html")


app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
