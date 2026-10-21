"""Build data/books.json from a curated title list, enriched via the Open Library API (CC0 data).

Run once:  python scripts/fetch_books.py
"""
import json
import re
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "books.json"
UA = {"User-Agent": "Shelfmark-dataset/1.0"}

# subject -> [(title, author, first published)]
CATALOG = {
    "Fantasy": [
        ("The Hobbit", "J. R. R. Tolkien", 1937),
        ("The Fellowship of the Ring", "J. R. R. Tolkien", 1954),
        ("A Game of Thrones", "George R. R. Martin", 1996),
        ("Harry Potter and the Philosopher's Stone", "J. K. Rowling", 1997),
        ("The Name of the Wind", "Patrick Rothfuss", 2007),
        ("Mistborn: The Final Empire", "Brandon Sanderson", 2006),
        ("A Wizard of Earthsea", "Ursula K. Le Guin", 1968),
        ("The Lion, the Witch and the Wardrobe", "C. S. Lewis", 1950),
        ("American Gods", "Neil Gaiman", 2001),
        ("The Way of Kings", "Brandon Sanderson", 2010),
        ("Good Omens", "Terry Pratchett", 1990),
        ("Alice's Adventures in Wonderland", "Lewis Carroll", 1865),
    ],
    "Science Fiction": [
        ("Dune", "Frank Herbert", 1965),
        ("Foundation", "Isaac Asimov", 1951),
        ("Neuromancer", "William Gibson", 1984),
        ("The Left Hand of Darkness", "Ursula K. Le Guin", 1969),
        ("Nineteen Eighty-Four", "George Orwell", 1949),
        ("Brave New World", "Aldous Huxley", 1932),
        ("Fahrenheit 451", "Ray Bradbury", 1953),
        ("The Hitchhiker's Guide to the Galaxy", "Douglas Adams", 1979),
        ("Ender's Game", "Orson Scott Card", 1985),
        ("The Martian", "Andy Weir", 2011),
        ("Frankenstein", "Mary Shelley", 1818),
        ("The Time Machine", "H. G. Wells", 1895),
    ],
    "Mystery": [
        ("The Hound of the Baskervilles", "Arthur Conan Doyle", 1902),
        ("The Murder of Roger Ackroyd", "Agatha Christie", 1926),
        ("And Then There Were None", "Agatha Christie", 1939),
        ("Murder on the Orient Express", "Agatha Christie", 1934),
        ("The Big Sleep", "Raymond Chandler", 1939),
        ("The Maltese Falcon", "Dashiell Hammett", 1930),
        ("Gone Girl", "Gillian Flynn", 2012),
        ("The Girl with the Dragon Tattoo", "Stieg Larsson", 2005),
        ("The Da Vinci Code", "Dan Brown", 2003),
        ("The Name of the Rose", "Umberto Eco", 1980),
        ("The Moonstone", "Wilkie Collins", 1868),
        ("Rebecca", "Daphne du Maurier", 1938),
    ],
    "Romance": [
        ("Pride and Prejudice", "Jane Austen", 1813),
        ("Jane Eyre", "Charlotte Brontë", 1847),
        ("Wuthering Heights", "Emily Brontë", 1847),
        ("Emma", "Jane Austen", 1815),
        ("Persuasion", "Jane Austen", 1817),
        ("Outlander", "Diana Gabaldon", 1991),
        ("The Notebook", "Nicholas Sparks", 1996),
        ("Me Before You", "Jojo Moyes", 2012),
        ("Normal People", "Sally Rooney", 2018),
        ("The Fault in Our Stars", "John Green", 2012),
        ("Gone with the Wind", "Margaret Mitchell", 1936),
        ("Sense and Sensibility", "Jane Austen", 1811),
    ],
    "Horror": [
        ("Dracula", "Bram Stoker", 1897),
        ("The Shining", "Stephen King", 1977),
        ("It", "Stephen King", 1986),
        ("Carrie", "Stephen King", 1974),
        ("The Haunting of Hill House", "Shirley Jackson", 1959),
        ("Rosemary's Baby", "Ira Levin", 1967),
        ("The Exorcist", "William Peter Blatty", 1971),
        ("Interview with the Vampire", "Anne Rice", 1976),
        ("Strange Case of Dr Jekyll and Mr Hyde", "Robert Louis Stevenson", 1886),
        ("The Picture of Dorian Gray", "Oscar Wilde", 1890),
        ("Pet Sematary", "Stephen King", 1983),
        ("Coraline", "Neil Gaiman", 2002),
    ],
    "Historical Fiction": [
        ("War and Peace", "Leo Tolstoy", 1869),
        ("A Tale of Two Cities", "Charles Dickens", 1859),
        ("The Book Thief", "Markus Zusak", 2005),
        ("All the Light We Cannot See", "Anthony Doerr", 2014),
        ("Wolf Hall", "Hilary Mantel", 2009),
        ("The Pillars of the Earth", "Ken Follett", 1989),
        ("I, Claudius", "Robert Graves", 1934),
        ("Les Misérables", "Victor Hugo", 1862),
        ("The Count of Monte Cristo", "Alexandre Dumas", 1844),
        ("The Nightingale", "Kristin Hannah", 2015),
        ("Memoirs of a Geisha", "Arthur Golden", 1997),
        ("Midnight's Children", "Salman Rushdie", 1981),
    ],
    "Poetry": [
        ("Leaves of Grass", "Walt Whitman", 1855),
        ("The Waste Land", "T. S. Eliot", 1922),
        ("Gitanjali", "Rabindranath Tagore", 1910),
        ("The Prophet", "Kahlil Gibran", 1923),
        ("Milk and Honey", "Rupi Kaur", 2014),
        ("Ariel", "Sylvia Plath", 1965),
        ("Paradise Lost", "John Milton", 1667),
        ("The Divine Comedy", "Dante Alighieri", 1320),
        ("Shakespeare's Sonnets", "William Shakespeare", 1609),
        ("The Sun and Her Flowers", "Rupi Kaur", 2017),
        ("Songs of Innocence and of Experience", "William Blake", 1789),
        ("The Raven and Other Poems", "Edgar Allan Poe", 1845),
    ],
    "Biography": [
        ("The Diary of a Young Girl", "Anne Frank", 1947),
        ("Long Walk to Freedom", "Nelson Mandela", 1994),
        ("Steve Jobs", "Walter Isaacson", 2011),
        ("Wings of Fire", "A. P. J. Abdul Kalam", 1999),
        ("The Story of My Experiments with Truth", "Mahatma Gandhi", 1927),
        ("I Know Why the Caged Bird Sings", "Maya Angelou", 1969),
        ("Educated", "Tara Westover", 2018),
        ("Becoming", "Michelle Obama", 2018),
        ("The Autobiography of Malcolm X", "Malcolm X", 1965),
        ("Einstein: His Life and Universe", "Walter Isaacson", 2007),
        ("Surely You're Joking, Mr. Feynman!", "Richard P. Feynman", 1985),
        ("Born a Crime", "Trevor Noah", 2016),
    ],
    "History": [
        ("Sapiens", "Yuval Noah Harari", 2011),
        ("Guns, Germs, and Steel", "Jared Diamond", 1997),
        ("The Guns of August", "Barbara W. Tuchman", 1962),
        ("The Rise and Fall of the Third Reich", "William L. Shirer", 1960),
        ("A People's History of the United States", "Howard Zinn", 1980),
        ("The Discovery of India", "Jawaharlal Nehru", 1946),
        ("India After Gandhi", "Ramachandra Guha", 2007),
        ("SPQR", "Mary Beard", 2015),
        ("The Silk Roads", "Peter Frankopan", 2015),
        ("Team of Rivals", "Doris Kearns Goodwin", 2005),
        ("The Wright Brothers", "David McCullough", 2015),
        ("1491", "Charles C. Mann", 2005),
    ],
    "Science": [
        ("A Brief History of Time", "Stephen Hawking", 1988),
        ("The Selfish Gene", "Richard Dawkins", 1976),
        ("Cosmos", "Carl Sagan", 1980),
        ("On the Origin of Species", "Charles Darwin", 1859),
        ("The Double Helix", "James D. Watson", 1968),
        ("Silent Spring", "Rachel Carson", 1962),
        ("The Gene", "Siddhartha Mukherjee", 2016),
        ("The Emperor of All Maladies", "Siddhartha Mukherjee", 2010),
        ("The Elegant Universe", "Brian Greene", 1999),
        ("A Short History of Nearly Everything", "Bill Bryson", 2003),
        ("The Structure of Scientific Revolutions", "Thomas S. Kuhn", 1962),
        ("Astrophysics for People in a Hurry", "Neil deGrasse Tyson", 2017),
    ],
    "Philosophy": [
        ("Meditations", "Marcus Aurelius", 180),
        ("Thus Spoke Zarathustra", "Friedrich Nietzsche", 1883),
        ("Beyond Good and Evil", "Friedrich Nietzsche", 1886),
        ("The Myth of Sisyphus", "Albert Camus", 1942),
        ("Critique of Pure Reason", "Immanuel Kant", 1781),
        ("The Prince", "Niccolò Machiavelli", 1532),
        ("Man's Search for Meaning", "Viktor E. Frankl", 1946),
        ("Sophie's World", "Jostein Gaarder", 1991),
        ("Leviathan", "Thomas Hobbes", 1651),
        ("Being and Nothingness", "Jean-Paul Sartre", 1943),
        ("The Social Contract", "Jean-Jacques Rousseau", 1762),
        ("Discourse on the Method", "René Descartes", 1637),
    ],
    "Programming": [
        ("Design Patterns: Elements of Reusable Object-Oriented Software", "Erich Gamma", 1994),
        ("Clean Code", "Robert C. Martin", 2008),
        ("The Pragmatic Programmer", "Andrew Hunt", 1999),
        ("Refactoring", "Martin Fowler", 1999),
        ("Code Complete", "Steve McConnell", 1993),
        ("The Mythical Man-Month", "Frederick P. Brooks", 1975),
        ("Introduction to Algorithms", "Thomas H. Cormen", 1990),
        ("Structure and Interpretation of Computer Programs", "Harold Abelson", 1985),
        ("The C Programming Language", "Brian W. Kernighan", 1978),
        ("Object-Oriented Software Construction", "Bertrand Meyer", 1988),
        ("Applying UML and Patterns", "Craig Larman", 1997),
        ("UML Distilled", "Martin Fowler", 1997),
        ("Domain-Driven Design", "Eric Evans", 2003),
        ("Head First Design Patterns", "Eric Freeman", 2004),
    ],
}


# Short summaries for works Open Library has no description for.
NOTES = {
    "The Girl with the Dragon Tattoo": "Disgraced journalist Mikael Blomkvist and the brilliant, troubled hacker Lisbeth Salander investigate a forty-year-old disappearance inside a wealthy Swedish family, uncovering a legacy of violence and corruption.",
    "The Name of the Rose": "In 1327, Franciscan friar William of Baskerville and his novice Adso arrive at an Italian abbey where monks are dying in mysterious circumstances. A medieval murder mystery woven through theology, books and the politics of the Church.",
    "The Divine Comedy": "Dante's epic journey through Inferno, Purgatorio and Paradiso, guided first by the poet Virgil and then by Beatrice, and a sweeping vision of the medieval cosmos.",
    "The Story of My Experiments with Truth": "Mahatma Gandhi's autobiography, from his childhood and years in South Africa to the Indian independence movement, and the personal experiments in non-violence, simplicity and truth that shaped him.",
    "The Autobiography of Malcolm X": "Told to Alex Haley, the life of Malcolm X: a turbulent childhood, prison, his rise as a leader of the Nation of Islam and his later break with it. One of the defining American memoirs of the twentieth century.",
    "Thus Spoke Zarathustra": "Nietzsche's philosophical novel follows the prophet Zarathustra as he descends from the mountains to teach about the death of God, the Übermensch and the eternal recurrence.",
    "Beyond Good and Evil": "Nietzsche attacks the dogmatism of earlier philosophers and of traditional morality, calling for free spirits willing to question the value of truth itself.",
    "Critique of Pure Reason": "Kant's landmark inquiry into the limits of human knowledge, arguing that the mind actively structures experience through space, time and the categories of understanding.",
    "Man's Search for Meaning": "Psychiatrist Viktor Frankl recounts his years in Nazi concentration camps and introduces logotherapy: the idea that our deepest drive is not pleasure but the search for meaning.",
    "Sophie's World": "Fourteen-year-old Sophie Amundsen starts receiving mysterious letters that lead her through the history of Western philosophy, in a novel that is itself a philosophical puzzle.",
    "Being and Nothingness": "Sartre's major work of existentialism, exploring consciousness, freedom and bad faith, and the claim that existence precedes essence and we are condemned to be free.",
    "The Social Contract": "Rousseau argues that legitimate political authority rests on a contract among free citizens and introduces the general will, a text that shaped modern democratic thought.",
    "Discourse on the Method": "Descartes sets out his method of systematic doubt, arrives at 'I think, therefore I am', and lays foundations for modern philosophy and science.",
    "Clean Code": "A handbook of software craftsmanship: how to write code that is readable, maintainable and testable, taught through principles, smells and real refactoring case studies.",
    "Refactoring": "Martin Fowler's catalogue of behaviour-preserving transformations for improving the design of existing code, with guidance on when to refactor and how to do it safely with tests.",
    "Applying UML and Patterns": "An introduction to object-oriented analysis and design with the Unified Process: use cases, domain models, GRASP responsibility assignment and design patterns, taught through iterative case studies.",
    "Domain-Driven Design": "Eric Evans' approach to tackling software complexity by modelling the core domain: ubiquitous language, bounded contexts, entities, value objects and aggregates.",
    "Head First Design Patterns": "A visual, brain-friendly guide to the classic object-oriented design patterns (Strategy, Observer, Decorator, Factory, Singleton and more) and the principles behind them.",
}


# Standard English editions for works whose Open Library record carries no ISBN.
ISBNS = {
    "The Name of the Rose": "9780156001311",
    "The Count of Monte Cristo": "9780140449266",
    "The Autobiography of Malcolm X": "9780345350688",
}


def isbn13(isbns):
    """Prefer an English-market ISBN-13 (978-0/978-1); convert an ISBN-10 if that's all there is."""
    thirteens = [i for i in isbns if len(i) == 13 and i.isdigit() and i.startswith("978")]
    for prefix in ("9780", "9781", "978"):
        hit = next((i for i in thirteens if i.startswith(prefix)), None)
        if hit:
            return hit
    ten = next((i for i in isbns if len(i) == 10 and i[:9].isdigit()), None)
    if ten:
        core = "978" + ten[:9]
        check = (10 - sum(int(d) * (3 if n % 2 else 1) for n, d in enumerate(core)) % 10) % 10
        return core + str(check)
    return None


def get(url, tries=4):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return json.load(r)
        except (OSError, ValueError):
            if attempt == tries - 1:
                raise
            time.sleep(2 ** attempt)


def clean(text):
    text = text.split("----------")[0]
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)  # markdown links -> text
    text = re.sub(r"\[\d+\]:\s*\S+", "", text)
    text = re.sub(r"\(\s*\[?source\]?[^)]*\)", "", text, flags=re.I)
    text = re.sub(r"(\*\*|\*|__)", "", text)
    text = re.sub(r"^\s*>\s?", "", text, flags=re.M)  # markdown block quotes
    text = " ".join(text.split())
    if len(text) > 600:
        text = text[:600].rsplit(". ", 1)[0] + "."
    return text


def resolve(subject, title, author, year):
    q = urllib.parse.urlencode({
        "title": title.split(":")[0], "author": author.split()[-1], "limit": 5,
        "fields": "key,title,isbn,cover_i,publisher,number_of_pages_median",
    })
    docs = get(f"https://openlibrary.org/search.json?{q}")["docs"]
    doc = next((d for d in docs if d.get("cover_i")), None)
    if not doc:  # works catalogued under their original-language title only match free text
        q = urllib.parse.urlencode({"q": f"{title} {author}", "limit": 5,
                                    "fields": "key,title,isbn,cover_i,publisher,number_of_pages_median"})
        docs = get(f"https://openlibrary.org/search.json?{q}")["docs"] or docs
        doc = next((d for d in docs if d.get("cover_i")), docs[0] if docs else {})
    isbn = isbn13(doc.get("isbn") or []) or ISBNS.get(title)
    book = {
        "isbn": isbn, "title": title, "author": author, "subject": subject, "year": year,
        "publisher": (doc.get("publisher") or [None])[0], "pages": doc.get("number_of_pages_median"),
        "cover_id": doc.get("cover_i"), "description": None,
    }
    if isbn:
        try:
            ed = get(f"https://openlibrary.org/isbn/{isbn}.json")
            book["publisher"] = (ed.get("publishers") or [book["publisher"]])[0]
            book["pages"] = ed.get("number_of_pages") or book["pages"]
            book["cover_id"] = next((c for c in ed.get("covers", []) if c > 0), book["cover_id"])  # the edition's own cover
        except Exception:
            pass
    if doc.get("key"):
        try:
            desc = get(f"https://openlibrary.org{doc['key']}.json").get("description")
            if isinstance(desc, dict):
                desc = desc.get("value")
            book["description"] = clean(desc) if desc else None
        except Exception:
            pass
    book["description"] = book["description"] or NOTES.get(title)
    if book["publisher"] and book["publisher"].islower():
        book["publisher"] = book["publisher"].title()
    print(f"{'ok ' if isbn and book['cover_id'] else '-- '} {subject:18} {title}")
    return book


def main():
    jobs = [(s, *b) for s, books in CATALOG.items() for b in books]
    with ThreadPoolExecutor(max_workers=4) as pool:
        books = list(pool.map(lambda j: resolve(*j), jobs))
    isbns = [b["isbn"] for b in books]
    assert all(isbns) and len(set(isbns)) == len(isbns), "every book needs a unique ISBN"
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(books, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"\n{len(books)} books -> {OUT}")


if __name__ == "__main__":
    main()
