# Shelfmark

A small but complete **library management system**, built as an Object-Oriented Software Development case study. Members search the catalogue, reserve titles that are out and renew their loans. Librarians run the circulation desk: issuing and returning copies by barcode, collecting fines and managing the catalogue and memberships.

**Live demo:** {{LIVE_URL}} &nbsp;·&nbsp; **API docs:** {{LIVE_URL}}/docs

| Demo account | Email | Password |
|---|---|---|
| Librarian (Desk) | `librarian@shelfmark.test` | `shelfmark` |
| Student member | `student@shelfmark.test` | `shelfmark` |
| Faculty member | `faculty@shelfmark.test` | `shelfmark` |

![Landing page](docs/landing.webp)

## What it does

**Visitors** can browse the landing page, which shows live catalogue figures, the most borrowed titles and the subject shelves. They can search the catalogue by title, author, ISBN, subject and publication year, and see every copy of a title with its rack and status.

**Members** (Student or Faculty) can:
- sign up and get a library card with a barcode;
- reserve a title when every copy is out, joining a first-come, first-served queue;
- renew a loan once, provided it isn't overdue and nobody is queued for it;
- see their loans, due dates, accruing late fees, holds, fines and notices in one place.

**Librarians** use the Desk, which opens on the counter:
- issue and return side by side: scan a library card and a book's barcode, see who and what before confirming (USB scanners work as keyboards);
- four live counts (on loan, overdue, holds ready, unpaid fines), the overdue list, holds to hand over in one click and recent activity;
- tabs for loans, reservations, fines, members (register, suspend, reinstate) and the catalogue (with an Open Library ISBN lookup when adding titles).

| Member catalog | My shelf |
|---|---|
| ![Catalog](docs/catalog.webp) | ![My shelf](docs/shelf.webp) |
| **Librarian desk** | **On a phone** |
| ![Desk](docs/desk.webp) | ![Phone](docs/mobile.webp) |

## Case study requirements

| Requirement | How Shelfmark meets it |
|---|---|
| Search books by title, author, subject category and publication date | `GET /api/books?q=&by=title\|author\|isbn&subject=&year_from=&year_to=` |
| Every book has a unique identifier and a rack number to locate it | ISBN on `Book`; a barcode and rack (e.g. `FAN-01A`) on every `BookItem` |
| More than one copy of a book (*book items*) | `Book 1 ── * BookItem`; copies can be added, written off and found again |
| Who has a particular book, and what a member has borrowed | Desk → Loans (search by member, card, title or barcode), member cards, copy scans |
| Maximum books per member | Students 5, faculty 10 (`Member.max_books`) |
| Maximum days a book can be kept | Students 10 days, faculty 30 (`Member.loan_days`), one renewal |
| Fines for late returns | On return: days late × daily rate (₹5 student, ₹2 faculty); unpaid fines block borrowing |
| Reserve books that aren't available | Reservation queue per title; the returned copy is held for 3 days for the first in line |
| Notify when a reserved book is available, or a book is overdue | `MemberNotifier` observer posts in-app notices |
| Barcodes on books and library cards | Every copy has a barcode (`SM000123`), every member card a CODE128 barcode; the desk's inputs work with USB scanners |

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
    participant D as Desk (browser)
    participant A as FastAPI
    participant Lib as Library
    participant M as Member
    participant O as Observers
    L->>D: scan library card, scan book
    D->>A: POST /api/desk/issue {card_no, barcode}
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

Time-based rules (overdue notices and expired holds) are applied by `Library.sweep()`. It runs when the desk's counter or a member's account is loaded, so no scheduler is needed for a single-instance deployment.

## Architecture

```
Browser ── landing / catalog / desk (HTML, CSS, vanilla JS)
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
web/            landing (index), catalog and desk pages on one shared theme.css and shared.js
data/books.json 146 curated titles enriched from Open Library
scripts/        dataset builder
tests/          unit tests for every business rule
```

- **Backend:** Python 3.13, FastAPI, SQLAlchemy 2, psycopg 3
- **Auth:** scrypt-hashed passwords, signed session cookie (`HttpOnly`, `SameSite=Lax`, `Secure` in production), role guards per endpoint
- **Frontend:** plain HTML/CSS/JS with no build step: one theme for all three pages, CSS animations, plus JsBarcode and Phosphor icons from CDNs
- **Data:** demo seed with 146 books, 311 copies, 39 accounts and six weeks of simulated circulation. The simulation runs through the same `Library` class the API uses, so every loan, fine, hold and notice obeys the real rules.

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
| Member catalog | `/catalog` |
| Librarian desk | `/desk` |
| Interactive API docs | `/docs` |

## Deploy

The repo includes a Render blueprint ([`render.yaml`](render.yaml)) for a free web service, backed by a free Neon Postgres database.

1. Create a Neon project and copy its **pooled** connection string.
2. [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)]({{DEPLOY_URL}}) and paste the connection string as `DATABASE_URL`. `SECRET_KEY` is generated for you.
3. On first boot the app creates its tables and seeds the demo data.

## Dataset

[`scripts/fetch_books.py`](scripts/fetch_books.py) builds `data/books.json` from a curated list of 146 well-known titles across 12 subjects. Each title is enriched through the [Open Library API](https://openlibrary.org/developers/api) (CC0) with its ISBN, cover, publisher, page count and description.

## Credits

- Interface adapted from CodePen pens (MIT) and unified into one theme: the hero is **[SVG] [CSS] Marquee Glass Bubble** by [Fernando Cohen](https://codepen.io/designfenix); the paper palette, dark tiles and pale platform come from **3D Data cards menu** by Deckard; the stat tiles, segmented filters, switches and sheets follow the **Bento element lab** by Mohammad Abu Sakour; the striped attention strip is from **HYPER LINK, a sandbox concept** by Pharaoh Leap.
- Book data and covers: [Open Library](https://openlibrary.org). Photography: [Unsplash](https://unsplash.com). Icons: [Phosphor](https://phosphoricons.com). Barcodes: [JsBarcode](https://github.com/lindell/JsBarcode).
