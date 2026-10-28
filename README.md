# Shelfmark

A small but complete **library management system**, built as an Object-Oriented Software Development case study. It is two apps on one database:

- **Shelfmark** for students and faculty: search the catalogue, reserve titles that are out, renew loans and keep track of fines and notices.
- **Shelfmark Admin** for library staff: issue and return copies by barcode, collect fines, and manage the catalogue and memberships.

**Live demo:** <https://shelfmark-qri1.onrender.com>

| App | Sign in at | Login | Password |
|---|---|---|---|
| Shelfmark (student) | `/catalog` | `student@shelfmark.test` or card `LIB10001` | `shelfmark` |
| Shelfmark (faculty) | `/catalog` | `faculty@shelfmark.test` or card `LIB10002` | `shelfmark` |
| Shelfmark Admin (librarian) | `/admin` | staff ID `STAFF001` | `shelfmark-admin` |

Members and staff sign in at separate doors with separate sessions, so both apps can be open side by side in one browser. The interactive API docs at `/docs` are for signed-in staff only.

![Landing page](docs/landing.webp)

## What it does

**Visitors** can browse the landing page, which shows live catalogue figures, the most borrowed titles and the subject shelves. They can search the catalogue by title, author, ISBN, subject and publication year, and see every copy of a title with its rack and status.

**Members** (Student or Faculty) use Shelfmark to:
- sign up and get a library card with a barcode, then sign in with their email or card number;
- reserve a title when every copy is out, joining a first-come, first-served queue;
- renew a loan once, provided it isn't overdue and nobody is queued for it;
- see their loans, due dates, accruing late fees, holds, fines and notices on *My shelf*.

**Librarians** sign in to Shelfmark Admin with their staff ID. It opens on the counter:
- issue and return side by side: scan a library card and a book's barcode, see who and what before confirming (USB scanners work as keyboards);
- four live counts (on loan, overdue, holds ready, unpaid fines), holds to hand over in one click, the overdue list and an activity feed from every account that refreshes itself;
- tabs for loans, reservations, fines, members (register, suspend, reinstate, see a card's recent activity) and the catalogue (with an Open Library ISBN lookup when adding titles).

| Shelfmark: the catalog | Shelfmark: my shelf |
|---|---|
| ![Catalog](docs/catalog.webp) | ![My shelf](docs/shelf.webp) |
| **Shelfmark Admin** | **On a phone** |
| ![Shelfmark Admin](docs/admin.webp) | ![Phone](docs/mobile.webp) |

## Case study requirements

| Requirement | How Shelfmark meets it |
|---|---|
| Search books by title, author, subject category and publication date | `GET /api/books?q=&by=title\|author\|isbn&subject=&year_from=&year_to=` |
| Every book has a unique identifier and a rack number to locate it | ISBN on `Book`; a barcode and rack (e.g. `FAN-01A`) on every `BookItem` |
| More than one copy of a book (*book items*) | `Book 1 ── * BookItem`; copies can be added, written off and found again |
| Who has a particular book, and what a member has borrowed | Admin → Loans (search by member, card, title or barcode), member cards, copy scans |
| Maximum books per member | Students 5, faculty 10 (`Member.max_books`) |
| Maximum days a book can be kept | Students 10 days, faculty 30 (`Member.loan_days`), one renewal |
| Fines for late returns | On return: days late × daily rate (₹5 student, ₹2 faculty); unpaid fines block borrowing |
| Reserve books that aren't available | Reservation queue per title; the returned copy is held for 3 days for the first in line |
| Notify when a reserved book is available, or a book is overdue | `MemberNotifier` observer posts in-app notices |
| Barcodes on books and library cards | Every copy has a barcode (`SM000123`), every member card a CODE128 barcode; the Admin counter works with USB scanners |

## Object-oriented design

### Use cases

```mermaid
flowchart LR
    V([Visitor])
    M([Member])
    L([Librarian])
    subgraph Shelfmark
        S[Search catalogue]
        C[See copies and racks]
        J[Sign up / sign in]
        R[Reserve a title]
        N[Renew a loan]
        A[View loans, fines and notices]
        I[Issue a copy]
        T[Return a copy]
        F[Collect a fine]
        K[Manage catalogue and copies]
        E[Manage members]
        D[Monitor overdue loans and holds]
    end
    V --- S & C & J
    M --- S & R & N & A
    L --- I & T & F & K & E & D
```

### Class diagram

```mermaid
classDiagram
    direction LR
    class User {
        <<abstract>>
        +name
        +email
        +card_no
        +active
        +set_password(password)
        +check_password(password) bool
    }
    class Member {
        <<abstract>>
        +max_books
        +loan_days
        +fine_per_day
        +active_loans() list~Loan~
        +fines_due() int
        +ensure_can_borrow()
    }
    class Student {
        max_books = 5
        loan_days = 10
        fine_per_day = 5
    }
    class Faculty {
        max_books = 10
        loan_days = 30
        fine_per_day = 2
    }
    class Librarian
    class Book {
        +isbn
        +title
        +author
        +subject
        +year
        +count(status) int
        +queue() list~Reservation~
    }
    class BookItem {
        +barcode
        +rack
        +status
        +current_loan() Loan
    }
    class Loan {
        +issued_on
        +due_on
        +returned_on
        +renewals
        +days_overdue(on) int
    }
    class Reservation {
        +status
        +hold_until
    }
    class Fine {
        +amount
        +paid_on
    }
    class Notification {
        +kind
        +message
        +read
    }
    class Library {
        <<facade>>
        +search()
        +issue(member, item) Loan
        +return_item(item) Loan
        +renew(loan, member) Loan
        +reserve(member, book) Reservation
        +cancel(reservation, member)
        +collect(fine)
        +sweep()
        +catalogue(book, copies, rack)
        +register(kind, name, email, password) Member
    }
    class Observer {
        <<abstract>>
        +update(event, at, data)*
    }
    User <|-- Member
    User <|-- Librarian
    Member <|-- Student
    Member <|-- Faculty
    Book "1" *-- "*" BookItem : copies
    BookItem "1" -- "*" Loan
    Member "1" -- "*" Loan
    Loan "1" -- "0..1" Fine
    Member "1" -- "*" Reservation
    Book "1" -- "*" Reservation
    User "1" -- "*" Notification
    Library o-- Observer
    Observer <|-- MemberNotifier
    Observer <|-- ActivityLog
```

### Design patterns and principles

| Pattern | Where | Why |
|---|---|---|
| **Inheritance & polymorphism** | `User → Member → Student / Faculty`, `Librarian` in [`app/models.py`](app/models.py) | Limits, loan period and fine rate are class attributes, so rules ask `member.max_books` instead of switching on a type code. Adding a membership type is a new subclass. |
| **Facade** | `Library` in [`app/library.py`](app/library.py) | One entry point for every use case. The HTTP layer stays thin and the rules are testable without a web server. |
| **Observer** | `Observer` → `MemberNotifier`, `ActivityLog` | Circulation code publishes events (`issued`, `fine`, `reservation_ready`…); notices and the audit feed subscribe without the domain knowing about them. |
| **Factory** | `MEMBER_TYPES` + `Library.register(kind, …)` | The requested membership type chooses which `Member` subclass is created. |
| **Encapsulation** | `Member.ensure_can_borrow()`, `Book.queue`, `Loan.days_overdue()` | Invariants live with the data they protect. |
| **Unit of Work / ORM mapping** | SQLAlchemy `Session`, single-table inheritance on `users.role` | The class hierarchy maps onto one table, and each request commits or rolls back as a unit. |

### Issuing a book

```mermaid
sequenceDiagram
    actor L as Librarian
    participant D as Admin (browser)
    participant A as FastAPI
    participant Lib as Library
    participant M as Member
    participant O as Observers
    L->>D: scan library card, scan book
    D->>A: POST /api/admin/issue {card_no, barcode}
    A->>Lib: issue(member, item)
    Lib->>M: ensure_can_borrow()
    Note right of M: suspended? unpaid fines?<br/>already at max_books?
    Lib->>Lib: copy on the shelf, or held for this member?
    Lib->>Lib: Loan(due = today + member.loan_days)
    Lib-->>O: publish("issued")
    O-->>O: MemberNotifier adds a notice<br/>ActivityLog adds a feed entry
    A-->>D: 201 Created (loan with due date)
```

### Returning a book

```mermaid
sequenceDiagram
    actor L as Librarian
    participant Lib as Library
    participant Q as Book.queue
    L->>Lib: return_item(copy)
    Lib->>Lib: loan.returned_on = today
    alt returned late
        Lib->>Lib: Fine(days late × fine_per_day)
        Lib-->>Lib: publish("fine")
    end
    Lib->>Q: anyone waiting?
    alt first member in the queue
        Lib->>Lib: copy ON_HOLD, reservation READY for 3 days
        Lib-->>Lib: publish("reservation_ready") so the member is notified
    else queue empty
        Lib->>Lib: copy AVAILABLE
    end
```

### Lifecycles

```mermaid
stateDiagram-v2
    direction LR
    state "Book item" as item {
        [*] --> Available: catalogued
        Available --> Loaned: issue
        Loaned --> Available: return, nobody queued
        Loaned --> OnHold: return, member queued
        OnHold --> Loaned: issued to the holder
        OnHold --> Available: hold expires or is cancelled
        Available --> Lost: written off
        Lost --> Available: found
    }
```

```mermaid
stateDiagram-v2
    direction LR
    state "Reservation" as res {
        [*] --> Waiting: reserve (no copy on the shelf)
        Waiting --> Ready: copy returned, first in line
        Ready --> Fulfilled: collected at the desk
        Ready --> Expired: not collected within 3 days
        Waiting --> Fulfilled: borrowed a shelf copy instead
        Waiting --> Cancelled
        Ready --> Cancelled
    }
```

Time-based rules (overdue notices and expired holds) are applied by `Library.sweep()`. It runs when the Admin counter or a member's shelf is loaded, so no scheduler is needed for a single-instance deployment.

## Architecture

```
Browser ── landing · Shelfmark (catalog) · Shelfmark Admin (HTML, CSS, vanilla JS)
   │  JSON over HTTPS, session cookie
FastAPI (app/main.py) ── validation, auth guards, JSON shapes
   │
Library facade (app/library.py) ── use cases, observers
   │
Domain model (app/models.py) ── entities and rules, mapped with SQLAlchemy
   │
PostgreSQL on Neon in production · SQLite locally
```

```
app/
  models.py     entities, inheritance hierarchy, business rules
  library.py    Library facade + observers (notifications, activity feed)
  main.py       REST API, auth, static pages
  seed.py       demo data, replayed through the Library facade
  db.py         engine and session setup
web/            landing (index), catalog and admin pages on one shared theme.css and shared.js
data/books.json 365 curated titles, details from Open Library
web/covers/     their front covers, one JPEG per ISBN
scripts/        dataset builder
tests/          unit tests for every business rule
```

- **Backend:** Python 3.13, FastAPI, SQLAlchemy 2, psycopg 3
- **Auth:** scrypt-hashed passwords; members and staff sign in at separate endpoints into separate slots of one signed session cookie (`HttpOnly`, `SameSite=Lax`, `Secure` in production); role guards on every endpoint
- **Frontend:** plain HTML/CSS/JS with no build step: one theme for every page, CSS animations and page transitions, plus JsBarcode and Phosphor icons from CDNs
- **Data:** demo seed with 365 books on 18 subject shelves, 777 copies, 63 accounts and two months of simulated circulation. The simulation runs through the same `Library` class the API uses, so every loan, fine, hold and notice obeys the real rules.

## Run it locally

```bash
python -m venv .venv
.venv\Scripts\activate            # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Open <http://localhost:8000>. The first start creates `shelfmark.db` (SQLite) and seeds the demo data. To use Postgres instead, copy `.env.example` to `.env`, fill in `DATABASE_URL` and start with `uvicorn app.main:app --env-file .env`.

```bash
python -m unittest        # 17 tests covering the case-study rules
```

| Page | URL |
|---|---|
| Landing | `/` |
| Shelfmark (members) | `/catalog` |
| Shelfmark Admin (staff) | `/admin` |
| Interactive API docs (staff only) | `/docs` |

## Deploy

One web service on Render's free plan and one free Neon Postgres database. Nothing else to set up.

1. On [Neon](https://neon.tech), create a project and copy its **pooled** connection string.
2. Click [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/AarushCh/Shelfmark) and paste that string as `DATABASE_URL`. Render generates `SECRET_KEY` itself.
3. The first boot creates the tables and seeds the demo library.

## Dataset

[`scripts/fetch_books.py`](scripts/fetch_books.py) builds `data/books.json` from a curated list of 365 well-known titles across 18 subjects. Each title is enriched through the [Open Library API](https://openlibrary.org/developers/api) (CC0) with its ISBN, publisher, page count and description, and its front cover is saved from Google Books into `web/covers/`, so the site never depends on another server for images. Re-running it only fetches titles that are new or changed.

## Credits

- Interface adapted from CodePen pens (MIT) and unified into one theme: the hero is **[SVG] [CSS] Marquee Glass Bubble** by [Fernando Cohen](https://codepen.io/designfenix); the paper palette, dark tiles and pale platform come from **3D Data cards menu** by Deckard; the stat tiles, segmented filters, switches and sheets follow the **Bento element lab** by Mohammad Abu Sakour; the striped attention strip is from **HYPER LINK, a sandbox concept** by Pharaoh Leap.
- Book data: [Open Library](https://openlibrary.org). Covers: [Google Books](https://books.google.com). Photography: [Unsplash](https://unsplash.com). Icons: [Phosphor](https://phosphoricons.com). Barcodes: [JsBarcode](https://github.com/lindell/JsBarcode).
