"""Build data/books.json and web/covers/ from a curated title list.

Book details come from the Open Library API (CC0 data). Front covers come from Google Books and are saved
next to the pages, so the site never waits on another server to show them.

Run once:  python scripts/fetch_books.py
"""
import hashlib
import json
import re
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "books.json"
COVERS = ROOT / "web" / "covers"
COVER = "https://books.google.com/books/content?vid=ISBN{}&printsec=frontcover&img=1&zoom=1&fife=w320"
GREY_BOOK = "85c95ad6e840cf7bbcec12fdf04e5b98"  # Google's "no cover" picture at 320 px
UA = {"User-Agent": "Shelfmark-dataset/1.0"}

# subject -> [(title, author, first published; negative years are BC)]
CATALOG = {
    "Fantasy": [
        ("The Hobbit", "J. R. R. Tolkien", 1937),
        ("The Fellowship of the Ring", "J. R. R. Tolkien", 1954),
        ("The Two Towers", "J. R. R. Tolkien", 1954),
        ("The Return of the King", "J. R. R. Tolkien", 1955),
        ("A Game of Thrones", "George R. R. Martin", 1996),
        ("Harry Potter and the Philosopher's Stone", "J. K. Rowling", 1997),
        ("Harry Potter and the Chamber of Secrets", "J. K. Rowling", 1998),
        ("Harry Potter and the Prisoner of Azkaban", "J. K. Rowling", 1999),
        ("The Name of the Wind", "Patrick Rothfuss", 2007),
        ("Mistborn: The Final Empire", "Brandon Sanderson", 2006),
        ("A Wizard of Earthsea", "Ursula K. Le Guin", 1968),
        ("The Lion, the Witch and the Wardrobe", "C. S. Lewis", 1950),
        ("American Gods", "Neil Gaiman", 2001),
        ("The Way of Kings", "Brandon Sanderson", 2010),
        ("Good Omens", "Terry Pratchett", 1990),
        ("The Colour of Magic", "Terry Pratchett", 1983),
        ("Alice's Adventures in Wonderland", "Lewis Carroll", 1865),
        ("The Eye of the World", "Robert Jordan", 1990),
        ("Circe", "Madeline Miller", 2018),
        ("The Night Circus", "Erin Morgenstern", 2011),
        ("The Alchemist", "Paulo Coelho", 1988),
    ],
    "Science Fiction": [
        ("Dune", "Frank Herbert", 1965),
        ("Foundation", "Isaac Asimov", 1951),
        ("I, Robot", "Isaac Asimov", 1950),
        ("Neuromancer", "William Gibson", 1984),
        ("The Left Hand of Darkness", "Ursula K. Le Guin", 1969),
        ("Nineteen Eighty-Four", "George Orwell", 1949),
        ("Brave New World", "Aldous Huxley", 1932),
        ("Fahrenheit 451", "Ray Bradbury", 1953),
        ("The Hitchhiker's Guide to the Galaxy", "Douglas Adams", 1979),
        ("Ender's Game", "Orson Scott Card", 1985),
        ("The Martian", "Andy Weir", 2011),
        ("Project Hail Mary", "Andy Weir", 2021),
        ("Frankenstein", "Mary Shelley", 1818),
        ("The Time Machine", "H. G. Wells", 1895),
        ("The War of the Worlds", "H. G. Wells", 1898),
        ("Do Androids Dream of Electric Sheep?", "Philip K. Dick", 1968),
        ("2001: A Space Odyssey", "Arthur C. Clarke", 1968),
        ("The Three-Body Problem", "Cixin Liu", 2008),
        ("Slaughterhouse-Five", "Kurt Vonnegut", 1969),
        ("The Handmaid's Tale", "Margaret Atwood", 1985),
    ],
    "Mystery": [
        ("A Study in Scarlet", "Arthur Conan Doyle", 1887),
        ("The Adventures of Sherlock Holmes", "Arthur Conan Doyle", 1892),
        ("The Hound of the Baskervilles", "Arthur Conan Doyle", 1902),
        ("The Murder of Roger Ackroyd", "Agatha Christie", 1926),
        ("And Then There Were None", "Agatha Christie", 1939),
        ("Murder on the Orient Express", "Agatha Christie", 1934),
        ("Death on the Nile", "Agatha Christie", 1937),
        ("The Big Sleep", "Raymond Chandler", 1939),
        ("The Maltese Falcon", "Dashiell Hammett", 1930),
        ("The Talented Mr. Ripley", "Patricia Highsmith", 1955),
        ("The Silence of the Lambs", "Thomas Harris", 1988),
        ("Gone Girl", "Gillian Flynn", 2012),
        ("The Girl on the Train", "Paula Hawkins", 2015),
        ("The Silent Patient", "Alex Michaelides", 2019),
        ("The Girl with the Dragon Tattoo", "Stieg Larsson", 2005),
        ("The Da Vinci Code", "Dan Brown", 2003),
        ("The Name of the Rose", "Umberto Eco", 1980),
        ("The Woman in White", "Wilkie Collins", 1859),
        ("The Moonstone", "Wilkie Collins", 1868),
        ("Rebecca", "Daphne du Maurier", 1938),
    ],
    "Romance": [
        ("Pride and Prejudice", "Jane Austen", 1813),
        ("Sense and Sensibility", "Jane Austen", 1811),
        ("Emma", "Jane Austen", 1815),
        ("Persuasion", "Jane Austen", 1817),
        ("Jane Eyre", "Charlotte Brontë", 1847),
        ("Wuthering Heights", "Emily Brontë", 1847),
        ("North and South", "Elizabeth Gaskell", 1855),
        ("Anna Karenina", "Leo Tolstoy", 1878),
        ("The Great Gatsby", "F. Scott Fitzgerald", 1925),
        ("Gone with the Wind", "Margaret Mitchell", 1936),
        ("Love in the Time of Cholera", "Gabriel García Márquez", 1985),
        ("Outlander", "Diana Gabaldon", 1991),
        ("The Notebook", "Nicholas Sparks", 1996),
        ("The Time Traveler's Wife", "Audrey Niffenegger", 2003),
        ("One Day", "David Nicholls", 2009),
        ("Me Before You", "Jojo Moyes", 2012),
        ("The Fault in Our Stars", "John Green", 2012),
        ("It Ends with Us", "Colleen Hoover", 2016),
        ("The Seven Husbands of Evelyn Hugo", "Taylor Jenkins Reid", 2017),
        ("Normal People", "Sally Rooney", 2018),
    ],
    "Horror": [
        ("Dracula", "Bram Stoker", 1897),
        ("The Shining", "Stephen King", 1977),
        ("It", "Stephen King", 1986),
        ("Carrie", "Stephen King", 1974),
        ("Pet Sematary", "Stephen King", 1983),
        ("The Haunting of Hill House", "Shirley Jackson", 1959),
        ("Rosemary's Baby", "Ira Levin", 1967),
        ("The Exorcist", "William Peter Blatty", 1971),
        ("Interview with the Vampire", "Anne Rice", 1976),
        ("Strange Case of Dr Jekyll and Mr Hyde", "Robert Louis Stevenson", 1886),
        ("The Picture of Dorian Gray", "Oscar Wilde", 1890),
        ("The Turn of the Screw", "Henry James", 1898),
        ("The Phantom of the Opera", "Gaston Leroux", 1910),
        ("The Call of Cthulhu and Other Weird Stories", "H. P. Lovecraft", 1928),
        ("I Am Legend", "Richard Matheson", 1954),
        ("The Woman in Black", "Susan Hill", 1983),
        ("Coraline", "Neil Gaiman", 2002),
        ("World War Z", "Max Brooks", 2006),
        ("Bird Box", "Josh Malerman", 2014),
        ("Mexican Gothic", "Silvia Moreno-Garcia", 2020),
    ],
    "Historical Fiction": [
        ("War and Peace", "Leo Tolstoy", 1869),
        ("A Tale of Two Cities", "Charles Dickens", 1859),
        ("Les Misérables", "Victor Hugo", 1862),
        ("The Count of Monte Cristo", "Alexandre Dumas", 1844),
        ("I, Claudius", "Robert Graves", 1934),
        ("Things Fall Apart", "Chinua Achebe", 1958),
        ("Midnight's Children", "Salman Rushdie", 1981),
        ("Beloved", "Toni Morrison", 1987),
        ("The Pillars of the Earth", "Ken Follett", 1989),
        ("Memoirs of a Geisha", "Arthur Golden", 1997),
        ("Atonement", "Ian McEwan", 2001),
        ("The Kite Runner", "Khaled Hosseini", 2003),
        ("The Book Thief", "Markus Zusak", 2005),
        ("The Boy in the Striped Pyjamas", "John Boyne", 2006),
        ("A Thousand Splendid Suns", "Khaled Hosseini", 2007),
        ("Wolf Hall", "Hilary Mantel", 2009),
        ("The Help", "Kathryn Stockett", 2009),
        ("All the Light We Cannot See", "Anthony Doerr", 2014),
        ("The Nightingale", "Kristin Hannah", 2015),
        ("A Gentleman in Moscow", "Amor Towles", 2016),
    ],
    "Indian Fiction": [
        ("Untouchable", "Mulk Raj Anand", 1935),
        ("Godaan", "Munshi Premchand", 1936),
        ("The Home and the World", "Rabindranath Tagore", 1916),
        ("Malgudi Days", "R. K. Narayan", 1943),
        ("The Guide", "R. K. Narayan", 1958),
        ("Train to Pakistan", "Khushwant Singh", 1956),
        ("The Room on the Roof", "Ruskin Bond", 1956),
        ("Clear Light of Day", "Anita Desai", 1980),
        ("The Shadow Lines", "Amitav Ghosh", 1988),
        ("Sea of Poppies", "Amitav Ghosh", 2008),
        ("A Suitable Boy", "Vikram Seth", 1993),
        ("A Fine Balance", "Rohinton Mistry", 1995),
        ("The God of Small Things", "Arundhati Roy", 1997),
        ("Interpreter of Maladies", "Jhumpa Lahiri", 1999),
        ("The Namesake", "Jhumpa Lahiri", 2003),
        ("Five Point Someone", "Chetan Bhagat", 2004),
        ("The Inheritance of Loss", "Kiran Desai", 2006),
        ("The White Tiger", "Aravind Adiga", 2008),
        ("The Palace of Illusions", "Chitra Banerjee Divakaruni", 2008),
        ("The Immortals of Meluha", "Amish Tripathi", 2010),
    ],
    "Young Adult": [
        ("Anne of Green Gables", "L. M. Montgomery", 1908),
        ("The Catcher in the Rye", "J. D. Salinger", 1951),
        ("Lord of the Flies", "William Golding", 1954),
        ("To Kill a Mockingbird", "Harper Lee", 1960),
        ("The Outsiders", "S. E. Hinton", 1967),
        ("The Giver", "Lois Lowry", 1993),
        ("Northern Lights", "Philip Pullman", 1995),
        ("Holes", "Louis Sachar", 1998),
        ("The Perks of Being a Wallflower", "Stephen Chbosky", 1999),
        ("Eragon", "Christopher Paolini", 2002),
        ("Twilight", "Stephenie Meyer", 2005),
        ("The Lightning Thief", "Rick Riordan", 2005),
        ("Looking for Alaska", "John Green", 2005),
        ("The Hunger Games", "Suzanne Collins", 2008),
        ("Catching Fire", "Suzanne Collins", 2009),
        ("The Maze Runner", "James Dashner", 2009),
        ("Divergent", "Veronica Roth", 2011),
        ("Wonder", "R. J. Palacio", 2012),
        ("Six of Crows", "Leigh Bardugo", 2015),
        ("The Hate U Give", "Angie Thomas", 2017),
    ],
    "Graphic Novels": [
        ("The Secret of the Unicorn", "Hergé", 1943),
        ("Asterix the Gaul", "René Goscinny", 1961),
        ("Akira, Vol. 1", "Katsuhiro Otomo", 1984),
        ("Maus", "Art Spiegelman", 1986),
        ("Batman: The Dark Knight Returns", "Frank Miller", 1986),
        ("Watchmen", "Alan Moore", 1987),
        ("V for Vendetta", "Alan Moore", 1988),
        ("The Sandman: Preludes & Nocturnes", "Neil Gaiman", 1989),
        ("The Indispensable Calvin and Hobbes", "Bill Watterson", 1992),
        ("Bone: Out from Boneville", "Jeff Smith", 1995),
        ("One Piece, Vol. 1", "Eiichiro Oda", 1997),
        ("Naruto, Vol. 1", "Masashi Kishimoto", 1999),
        ("Persepolis", "Marjane Satrapi", 2000),
        ("Blankets", "Craig Thompson", 2003),
        ("Death Note, Vol. 1", "Tsugumi Ohba", 2003),
        ("Fun Home", "Alison Bechdel", 2006),
        ("Attack on Titan, Vol. 1", "Hajime Isayama", 2009),
        ("Smile", "Raina Telgemeier", 2010),
        ("Nimona", "ND Stevenson", 2015),
        ("Heartstopper", "Alice Oseman", 2019),
    ],
    "Poetry": [
        ("The Divine Comedy", "Dante Alighieri", 1320),
        ("The Canterbury Tales", "Geoffrey Chaucer", 1400),
        ("Shakespeare's Sonnets", "William Shakespeare", 1609),
        ("Paradise Lost", "John Milton", 1667),
        ("Songs of Innocence and of Experience", "William Blake", 1789),
        ("Lyrical Ballads", "William Wordsworth", 1798),
        ("The Raven and Other Poems", "Edgar Allan Poe", 1845),
        ("Leaves of Grass", "Walt Whitman", 1855),
        ("The Rubaiyat of Omar Khayyam", "Omar Khayyam", 1859),
        ("Gitanjali", "Rabindranath Tagore", 1910),
        ("The Waste Land", "T. S. Eliot", 1922),
        ("The Prophet", "Kahlil Gibran", 1923),
        ("Twenty Love Poems and a Song of Despair", "Pablo Neruda", 1924),
        ("Madhushala", "Harivansh Rai Bachchan", 1935),
        ("Howl and Other Poems", "Allen Ginsberg", 1956),
        ("Ariel", "Sylvia Plath", 1965),
        ("Where the Sidewalk Ends", "Shel Silverstein", 1974),
        ("The Essential Rumi", "Rumi", 1995),
        ("Milk and Honey", "Rupi Kaur", 2014),
        ("The Sun and Her Flowers", "Rupi Kaur", 2017),
    ],
    "Biography": [
        ("The Story of My Life", "Helen Keller", 1903),
        ("The Story of My Experiments with Truth", "Mahatma Gandhi", 1927),
        ("The Diary of a Young Girl", "Anne Frank", 1947),
        ("The Autobiography of Malcolm X", "Malcolm X", 1965),
        ("I Know Why the Caged Bird Sings", "Maya Angelou", 1969),
        ("Surely You're Joking, Mr. Feynman!", "Richard P. Feynman", 1985),
        ("The Man Who Knew Infinity", "Robert Kanigel", 1991),
        ("Long Walk to Freedom", "Nelson Mandela", 1994),
        ("Into the Wild", "Jon Krakauer", 1996),
        ("A Beautiful Mind", "Sylvia Nasar", 1998),
        ("Wings of Fire", "A. P. J. Abdul Kalam", 1999),
        ("Alexander Hamilton", "Ron Chernow", 2004),
        ("Einstein: His Life and Universe", "Walter Isaacson", 2007),
        ("Steve Jobs", "Walter Isaacson", 2011),
        ("I Am Malala", "Malala Yousafzai", 2013),
        ("Playing It My Way", "Sachin Tendulkar", 2014),
        ("When Breath Becomes Air", "Paul Kalanithi", 2016),
        ("Born a Crime", "Trevor Noah", 2016),
        ("Educated", "Tara Westover", 2018),
        ("Becoming", "Michelle Obama", 2018),
    ],
    "History": [
        ("The Discovery of India", "Jawaharlal Nehru", 1946),
        ("Hiroshima", "John Hersey", 1946),
        ("The Wonder That Was India", "A. L. Basham", 1954),
        ("The Rise and Fall of the Third Reich", "William L. Shirer", 1960),
        ("The Guns of August", "Barbara W. Tuchman", 1962),
        ("Freedom at Midnight", "Larry Collins", 1975),
        ("A People's History of the United States", "Howard Zinn", 1980),
        ("The Making of the Atomic Bomb", "Richard Rhodes", 1986),
        ("Guns, Germs, and Steel", "Jared Diamond", 1997),
        ("Genghis Khan and the Making of the Modern World", "Jack Weatherford", 2004),
        ("Postwar", "Tony Judt", 2005),
        ("Team of Rivals", "Doris Kearns Goodwin", 2005),
        ("1491", "Charles C. Mann", 2005),
        ("India After Gandhi", "Ramachandra Guha", 2007),
        ("Sapiens", "Yuval Noah Harari", 2011),
        ("SPQR", "Mary Beard", 2015),
        ("The Silk Roads", "Peter Frankopan", 2015),
        ("The Wright Brothers", "David McCullough", 2015),
        ("An Era of Darkness", "Shashi Tharoor", 2016),
        ("The Anarchy", "William Dalrymple", 2019),
    ],
    "Science": [
        ("On the Origin of Species", "Charles Darwin", 1859),
        ("A Mathematician's Apology", "G. H. Hardy", 1940),
        ("Silent Spring", "Rachel Carson", 1962),
        ("The Structure of Scientific Revolutions", "Thomas S. Kuhn", 1962),
        ("The Double Helix", "James D. Watson", 1968),
        ("The Selfish Gene", "Richard Dawkins", 1976),
        ("Gödel, Escher, Bach", "Douglas R. Hofstadter", 1979),
        ("Cosmos", "Carl Sagan", 1980),
        ("Chaos: Making a New Science", "James Gleick", 1987),
        ("A Brief History of Time", "Stephen Hawking", 1988),
        ("Fermat's Last Theorem", "Simon Singh", 1997),
        ("The Elegant Universe", "Brian Greene", 1999),
        ("A Short History of Nearly Everything", "Bill Bryson", 2003),
        ("The Emperor of All Maladies", "Siddhartha Mukherjee", 2010),
        ("The Immortal Life of Henrietta Lacks", "Rebecca Skloot", 2010),
        ("Seven Brief Lessons on Physics", "Carlo Rovelli", 2014),
        ("The Sixth Extinction", "Elizabeth Kolbert", 2014),
        ("The Gene", "Siddhartha Mukherjee", 2016),
        ("Why We Sleep", "Matthew Walker", 2017),
        ("Astrophysics for People in a Hurry", "Neil deGrasse Tyson", 2017),
    ],
    "Psychology": [
        ("The Interpretation of Dreams", "Sigmund Freud", 1899),
        ("Man and His Symbols", "Carl G. Jung", 1964),
        ("Games People Play", "Eric Berne", 1964),
        ("Obedience to Authority", "Stanley Milgram", 1974),
        ("Influence: The Psychology of Persuasion", "Robert B. Cialdini", 1984),
        ("The Man Who Mistook His Wife for a Hat", "Oliver Sacks", 1985),
        ("Flow", "Mihaly Csikszentmihalyi", 1990),
        ("Emotional Intelligence", "Daniel Goleman", 1995),
        ("Mindset", "Carol S. Dweck", 2006),
        ("Stumbling on Happiness", "Daniel Gilbert", 2006),
        ("The Lucifer Effect", "Philip Zimbardo", 2007),
        ("Predictably Irrational", "Dan Ariely", 2008),
        ("Outliers", "Malcolm Gladwell", 2008),
        ("Drive", "Daniel H. Pink", 2009),
        ("Thinking, Fast and Slow", "Daniel Kahneman", 2011),
        ("Quiet", "Susan Cain", 2012),
        ("The Righteous Mind", "Jonathan Haidt", 2012),
        ("The Body Keeps the Score", "Bessel van der Kolk", 2014),
        ("Behave", "Robert M. Sapolsky", 2017),
        ("Maybe You Should Talk to Someone", "Lori Gottlieb", 2019),
    ],
    "Philosophy": [
        ("The Art of War", "Sun Tzu", -500),
        ("Tao Te Ching", "Lao Tzu", -400),
        ("The Republic", "Plato", -375),
        ("Nicomachean Ethics", "Aristotle", -340),
        ("The Bhagavad Gita", "Vyasa", -200),
        ("Meditations", "Marcus Aurelius", 180),
        ("The Prince", "Niccolò Machiavelli", 1532),
        ("Discourse on the Method", "René Descartes", 1637),
        ("Leviathan", "Thomas Hobbes", 1651),
        ("The Social Contract", "Jean-Jacques Rousseau", 1762),
        ("Critique of Pure Reason", "Immanuel Kant", 1781),
        ("The Communist Manifesto", "Karl Marx", 1848),
        ("On Liberty", "John Stuart Mill", 1859),
        ("Thus Spoke Zarathustra", "Friedrich Nietzsche", 1883),
        ("Beyond Good and Evil", "Friedrich Nietzsche", 1886),
        ("The Myth of Sisyphus", "Albert Camus", 1942),
        ("Being and Nothingness", "Jean-Paul Sartre", 1943),
        ("A History of Western Philosophy", "Bertrand Russell", 1945),
        ("Man's Search for Meaning", "Viktor E. Frankl", 1946),
        ("Sophie's World", "Jostein Gaarder", 1991),
    ],
    "Business": [
        ("The Wealth of Nations", "Adam Smith", 1776),
        ("The General Theory of Employment, Interest and Money", "John Maynard Keynes", 1936),
        ("The Intelligent Investor", "Benjamin Graham", 1949),
        ("The Goal", "Eliyahu M. Goldratt", 1984),
        ("The Innovator's Dilemma", "Clayton M. Christensen", 1997),
        ("Rich Dad Poor Dad", "Robert T. Kiyosaki", 1997),
        ("Basic Economics", "Thomas Sowell", 2000),
        ("Good to Great", "Jim Collins", 2001),
        ("Freakonomics", "Steven D. Levitt", 2005),
        ("Blue Ocean Strategy", "W. Chan Kim", 2005),
        ("The Black Swan", "Nassim Nicholas Taleb", 2007),
        ("Nudge", "Richard H. Thaler", 2008),
        ("Poor Economics", "Abhijit V. Banerjee", 2011),
        ("The Lean Startup", "Eric Ries", 2011),
        ("Capital in the Twenty-First Century", "Thomas Piketty", 2013),
        ("The Everything Store", "Brad Stone", 2013),
        ("Zero to One", "Peter Thiel", 2014),
        ("The Hard Thing About Hard Things", "Ben Horowitz", 2014),
        ("Shoe Dog", "Phil Knight", 2016),
        ("The Psychology of Money", "Morgan Housel", 2020),
    ],
    "Self-Help": [
        ("How to Win Friends and Influence People", "Dale Carnegie", 1936),
        ("Think and Grow Rich", "Napoleon Hill", 1937),
        ("The Magic of Thinking Big", "David J. Schwartz", 1959),
        ("The 7 Habits of Highly Effective People", "Stephen R. Covey", 1989),
        ("The Power of Now", "Eckhart Tolle", 1997),
        ("The Monk Who Sold His Ferrari", "Robin Sharma", 1997),
        ("The Four Agreements", "Don Miguel Ruiz", 1997),
        ("Who Moved My Cheese?", "Spencer Johnson", 1998),
        ("You Can Win", "Shiv Khera", 1998),
        ("Getting Things Done", "David Allen", 2001),
        ("Eat That Frog!", "Brian Tracy", 2001),
        ("The Power of Habit", "Charles Duhigg", 2012),
        ("Daring Greatly", "Brené Brown", 2012),
        ("The Courage to Be Disliked", "Ichiro Kishimi", 2013),
        ("Essentialism", "Greg McKeown", 2014),
        ("Deep Work", "Cal Newport", 2016),
        ("Grit", "Angela Duckworth", 2016),
        ("Ikigai", "Héctor García", 2016),
        ("Atomic Habits", "James Clear", 2018),
        ("Can't Hurt Me", "David Goggins", 2018),
    ],
    "Programming": [
        ("The Art of Computer Programming", "Donald E. Knuth", 1968),
        ("The Mythical Man-Month", "Frederick P. Brooks", 1975),
        ("The C Programming Language", "Brian W. Kernighan", 1978),
        ("Computer Networks", "Andrew S. Tanenbaum", 1981),
        ("Operating System Concepts", "Abraham Silberschatz", 1983),
        ("Structure and Interpretation of Computer Programs", "Harold Abelson", 1985),
        ("Introduction to Algorithms", "Thomas H. Cormen", 1990),
        ("Let Us C", "Yashavant Kanetkar", 1991),
        ("Code Complete", "Steve McConnell", 1993),
        ("Design Patterns: Elements of Reusable Object-Oriented Software", "Erich Gamma", 1994),
        ("Artificial Intelligence: A Modern Approach", "Stuart Russell", 1995),
        ("Applying UML and Patterns", "Craig Larman", 1997),
        ("UML Distilled", "Martin Fowler", 1997),
        ("The Pragmatic Programmer", "Andrew Hunt", 1999),
        ("Refactoring", "Martin Fowler", 1999),
        ("Effective Java", "Joshua Bloch", 2001),
        ("Test-Driven Development: By Example", "Kent Beck", 2002),
        ("Domain-Driven Design", "Eric Evans", 2003),
        ("Head First Java", "Kathy Sierra", 2003),
        ("Head First Design Patterns", "Eric Freeman", 2004),
        ("Clean Code", "Robert C. Martin", 2008),
        ("Growing Object-Oriented Software, Guided by Tests", "Steve Freeman", 2009),
        ("Cracking the Coding Interview", "Gayle Laakmann McDowell", 2008),
        ("Designing Data-Intensive Applications", "Martin Kleppmann", 2017),
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
    "The Phantom of the Opera": "Beneath the Paris Opera House lives a masked, disfigured genius who haunts the company and becomes obsessed with the young soprano Christine Daaé. Gaston Leroux's gothic romance is the source of countless stage and screen adaptations.",
    "Godaan": "Premchand's last completed novel follows Hori, a poor farmer whose lifelong wish is to own a cow, and through him the debt, caste and exploitation that shaped village life in north India. Often called the greatest Hindi novel.",
    "The Home and the World": "In Bengal during the Swadeshi movement, Bimala steps out of the women's quarters at her liberal husband Nikhil's urging, only to fall under the spell of his charismatic, radical friend Sandip. Tagore's novel weighs nationalism against conscience.",
    "The Namesake": "Gogol Ganguli, born in Massachusetts to Bengali parents and named after a Russian writer, spends years at odds with his name, his family and his heritage. Jhumpa Lahiri's first novel follows one immigrant family across three decades.",
    "The Secret of the Unicorn": "A model ship bought at a flea market draws Tintin into the hunt for the treasure of Sir Francis Haddock, Captain Haddock's ancestor, and for the three model Unicorns that each hide part of a clue.",
    "One Piece, Vol. 1": "Monkey D. Luffy, a boy whose body stretches like rubber after he ate a cursed Devil Fruit, sets out to sea to find the legendary treasure One Piece and become King of the Pirates, gathering a crew of misfits on the way.",
    "Naruto, Vol. 1": "Naruto Uzumaki, a loud, mischievous outcast with a fox spirit sealed inside him, dreams of becoming Hokage, the greatest ninja in his village. The first volume of Masashi Kishimoto's manga.",
    "The Rubaiyat of Omar Khayyam": "Edward FitzGerald's 1859 rendering of quatrains attributed to the Persian poet and astronomer Omar Khayyam: meditations on fate, the shortness of life and the pleasures of the moment, and among the most quoted poems in English.",
    "Twenty Love Poems and a Song of Despair": "Pablo Neruda was nineteen when he published these poems of longing, desire and loss, which became the best-selling book of poetry in the Spanish language.",
    "Madhushala": "Harivansh Rai Bachchan's 1935 cycle of quatrains uses the tavern, the wine, the cup and the server as metaphors for life, longing and mortality. One of the best-loved works of modern Hindi poetry.",
    "An Era of Darkness": "Shashi Tharoor's account of British rule in India, from the East India Company to 1947, arguing that colonialism impoverished and divided the country rather than modernising it. Published outside India as Inglorious Empire.",
    "The Anarchy": "William Dalrymple tells how the East India Company, a private trading corporation with its own army, came to conquer much of the Indian subcontinent in the second half of the eighteenth century.",
    "The Republic": "Socrates asks what justice is and answers by imagining an ideal city ruled by philosopher-kings. Plato's dialogue includes the allegory of the cave and is the founding text of Western political philosophy.",
    "The Hard Thing About Hard Things": "Ben Horowitz draws on his years founding and running Opsware to give blunt advice on the problems business schools skip: firing friends, managing your own psychology and steering a company through a crisis.",
    "You Can Win": "Shiv Khera's guide to success through a positive attitude, character and self-discipline, told in short chapters full of stories and maxims. One of the best-selling self-help books in India.",
    "The Art of Computer Programming": "Donald Knuth's monumental series on the analysis of algorithms. Volume 1, Fundamental Algorithms, lays the mathematical foundations, introduces the MIX machine and covers information structures such as lists and trees.",
    "Let Us C": "Yashavant Kanetkar's introduction to C programming and a staple of Indian engineering courses: data types, control flow, functions, pointers, arrays, strings, structures and file input/output, with exercises in every chapter.",
    "Effective Java": "Joshua Bloch's best-practice guide to the Java platform, organised as short items: creating and destroying objects, designing classes and interfaces, generics, enums, lambdas, exceptions and concurrency.",
    "Test-Driven Development: By Example": "Kent Beck introduces test-driven development by building code one failing test at a time, then distils the patterns behind the red, green, refactor rhythm.",
    "The Indispensable Calvin and Hobbes": "A treasury of Bill Watterson's strip about Calvin, a wildly imaginative six-year-old, and Hobbes, the tiger who is a stuffed toy to everyone else and a real friend to him. It gathers two earlier books of strips along with Sunday pages in colour.",
    "Nimona": "A shapeshifting girl talks her way into becoming sidekick to the villain Lord Ballister Blackheart, and together they set out to prove that the heroes of the Institution aren't as heroic as everyone thinks.",
    "Smile": "Raina Telgemeier's graphic memoir of the years after she knocked out her front teeth in sixth grade: braces, surgery, an earthquake and the ordinary agonies of growing up.",
    "Growing Object-Oriented Software, Guided by Tests": "Steve Freeman and Nat Pryce show how test-driven development and mock objects shape object-oriented design, growing a working auction application step by step from the first end-to-end test.",
    "Anna Karenina": "Anna, a married woman in St Petersburg society, risks everything for her affair with the cavalry officer Vronsky, while the landowner Levin searches for faith and purpose in the countryside. Tolstoy's great novel of passion, family and Russian society.",
    "Asterix the Gaul": "50 BC: all of Gaul is occupied by the Romans, except for one small village of indomitable Gauls who hold out thanks to their druid's magic potion. The first adventure of Asterix and Obelix.",
    "Seven Brief Lessons on Physics": "Carlo Rovelli's short, lyrical tour of modern physics: general relativity, quantum mechanics, the architecture of the cosmos, elementary particles, quantum gravity, black holes and our own place in the world they describe.",
    "The Interpretation of Dreams": "Sigmund Freud's founding work of psychoanalysis argues that dreams are disguised fulfilments of repressed wishes, and sets out a method for interpreting them through condensation, displacement and the workings of the unconscious.",
    "The Bhagavad Gita": "On the battlefield of Kurukshetra the warrior Arjuna hesitates to fight his own kin, and his charioteer Krishna answers with teachings on duty, selfless action, devotion and the nature of the self. Part of the Mahabharata and one of the central texts of Hindu thought.",
    "Head First Design Patterns": "A visual, brain-friendly guide to the classic object-oriented design patterns (Strategy, Observer, Decorator, Factory, Singleton and more) and the principles behind them.",
}


# Editions picked by hand: the work's Open Library record has no usable ISBN, or the first match had no cover,
# a cover in another language, a box set or the wrong book on it.
ISBNS = {
    "The Name of the Rose": "9780156001311",
    "The Count of Monte Cristo": "9780140449266",
    "The Autobiography of Malcolm X": "9780808501480",
    "The Hobbit": "9780261102217",
    "Harry Potter and the Philosopher's Stone": "9780747549550",
    "Mistborn: The Final Empire": "9780765350381",
    "Alice's Adventures in Wonderland": "9780141439761",
    "The Eye of the World": "9780812511819",
    "The Three-Body Problem": "9780765382030",
    "The Adventures of Sherlock Holmes": "9780140437713",
    "Death on the Nile": "9780007119325",
    "Gone Girl": "9780307588364",
    "The Girl with the Dragon Tattoo": "9780307454546",
    "Sense and Sensibility": "9780141439662",
    "Anna Karenina": "9780143035008",
    "One Day": "9780307474711",
    "Rosemary's Baby": "9781605981109",
    "Interview with the Vampire": "9780345337665",
    "The Picture of Dorian Gray": "9780141439570",
    "War and Peace": "9780140447934",
    "The Shadow Lines": "9780618329960",
    "The Palace of Illusions": "9781400096206",
    "Twilight": "9781904233657",
    "The Hate U Give": "9780062498533",
    "Asterix the Gaul": "9780752866055",
    "The Indispensable Calvin and Hobbes": "9780751500288",
    "Naruto, Vol. 1": "9781417651054",
    "Smile": "9780545132060",
    "Nimona": "9780062278227",
    "The Canterbury Tales": "9780140422344",
    "Shakespeare's Sonnets": "9781903436578",
    "Paradise Lost": "9780140424393",
    "The Raven and Other Poems": "9780439224062",
    "Gitanjali": "9780143419563",
    "Madhushala": "9788170283447",
    "The Story of My Experiments with Truth": "9780143330097",
    "Hiroshima": "9780679721031",
    "Freedom at Midnight": "9780006388517",
    "Cosmos": "9780345331359",
    "Seven Brief Lessons on Physics": "9780399184413",
    "Emotional Intelligence": "9780553804911",
    "The Interpretation of Dreams": "9780465019779",
    "Tao Te Ching": "9780060812454",
    "The Bhagavad Gita": "9780140449181",
    "The Communist Manifesto": "9780140447576",
    "Thus Spoke Zarathustra": "9780140441185",
    "Sophie's World": "9780374530716",
    "The Innovator's Dilemma": "9780875845852",
    "Shoe Dog": "9781501135910",
    "Think and Grow Rich": "9781585424337",
    "Can't Hurt Me": "9781544512273",
    "Operating System Concepts": "9781118063330",
    "Introduction to Algorithms": "9780262033848",
    "Let Us C": "9788176566216",
    "Head First Java": "9780596009205",
    "Head First Design Patterns": "9780596007126",
    "Growing Object-Oriented Software, Guided by Tests": "9780321503626",
}


def fetch(url, tries=4):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return r.read()
        except OSError:
            if attempt == tries - 1:
                raise
            time.sleep(2 ** attempt)


def get(url):
    return json.loads(fetch(url))


def to13(ten):
    core = "978" + ten[:9]
    return core + str((10 - sum(int(d) * (3 if n % 2 else 1) for n, d in enumerate(core)) % 10) % 10)


def candidates(isbns, preferred=None):
    """Editions to try for a cover: a chosen one first, then English-language (978-0, 978-1), then Indian (978-81, 978-93)."""
    found = [to13(i) if len(i) == 10 and i[:9].isdigit() else i for i in isbns]
    groups = ("9780", "9781", "97881", "97893")
    ranked = sorted((i for i in found if i.startswith(groups)), key=lambda i: next(n for n, g in enumerate(groups) if i.startswith(g)))
    return list(dict.fromkeys(([preferred] if preferred else []) + ranked))


def jpeg_size(data):
    """Width and height from a JPEG's frame header, or (0, 0) for anything else."""
    i = 2
    while data[:2] == b"\xff\xd8" and i + 9 <= len(data) and data[i] == 0xFF:
        if data[i + 1] in (0xC0, 0xC1, 0xC2):
            return int.from_bytes(data[i + 7:i + 9], "big"), int.from_bytes(data[i + 5:i + 7], "big")
        i += 2 + int.from_bytes(data[i + 2:i + 4], "big")
    return 0, 0


def save_cover(isbn, chosen=False):
    """Keep Google Books' front cover for an ISBN if it is a real one. Its stand-ins for a missing cover are a grey
    book (128 px, or one larger copy) and a near-blank white card of a few KB. Squarish images are usually audiobook
    boxes, so those are only taken for an edition picked by hand (some textbooks really are that shape)."""
    path = COVERS / f"{isbn}.jpg"
    if path.exists():
        return True
    data = fetch(COVER.format(isbn))
    width, height = jpeg_size(data)
    if (width < 200 or len(data) < 4000 or hashlib.md5(data).hexdigest() == GREY_BOOK
            or (not chosen and height < 1.25 * width)):
        return False
    path.write_bytes(data)
    return True


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
    fields = "key,title,isbn,publisher,number_of_pages_median"
    q = urllib.parse.urlencode({"title": title.split(":")[0], "author": author.split()[-1], "limit": 5, "fields": fields})
    docs = get(f"https://openlibrary.org/search.json?{q}")["docs"]
    doc = next((d for d in docs if d.get("isbn")), None)
    if not doc:  # works catalogued under their original-language title only match free text
        q = urllib.parse.urlencode({"q": f"{title} {author}", "limit": 5, "fields": fields})
        docs = get(f"https://openlibrary.org/search.json?{q}")["docs"] or docs
        doc = next((d for d in docs if d.get("isbn")), docs[0] if docs else {})
    editions = candidates(doc.get("isbn") or [], ISBNS.get(title))
    isbn = next((i for i in editions[:20] if save_cover(i, chosen=i == ISBNS.get(title))), editions[0] if editions else None)
    book = {
        "isbn": isbn, "title": title, "author": author, "subject": subject, "year": year,
        "publisher": (doc.get("publisher") or [None])[0], "pages": doc.get("number_of_pages_median"),
        "cover": f"/covers/{isbn}.jpg" if isbn and (COVERS / f"{isbn}.jpg").exists() else None,
        "description": None,
    }
    if isbn:
        try:
            ed = get(f"https://openlibrary.org/isbn/{isbn}.json")
            book["publisher"] = (ed.get("publishers") or [book["publisher"]])[0]
            book["pages"] = ed.get("number_of_pages") or book["pages"]
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
    if book["publisher"] and book["publisher"].islower():
        book["publisher"] = book["publisher"].title()
    print(f"{'ok ' if book['cover'] else '-- '} {subject:18} {title}")
    return book


def main():
    """Titles finished on an earlier run are kept as they are, so adding a title only fetches that one."""
    known = {b["title"]: b for b in json.loads(OUT.read_text(encoding="utf-8"))} if OUT.exists() else {}

    def build(subject, title, author, year):
        old = known.get(title)
        if (old and old.get("cover") and (ROOT / "web" / old["cover"].lstrip("/")).exists()
                and (old["subject"], old["author"], old["year"]) == (subject, author, year)
                and old["isbn"] == ISBNS.get(title, old["isbn"])):
            return old
        return resolve(subject, title, author, year)

    COVERS.mkdir(parents=True, exist_ok=True)
    jobs = [(s, *b) for s, books in CATALOG.items() for b in books]
    with ThreadPoolExecutor(max_workers=4) as pool:
        books = list(pool.map(lambda j: build(*j), jobs))
    for b in books:
        b["description"] = b["description"] or NOTES.get(b["title"])
    isbns = [b["isbn"] for b in books]
    for path in COVERS.glob("*.jpg"):  # covers of editions no longer listed
        if path.stem not in isbns:
            path.unlink()
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(books, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"\n{len(books)} books -> {OUT}", flush=True)
    for b in books:
        if not b["cover"] or not b["description"]:
            print(f"missing {'cover' if not b['cover'] else 'summary'}: {b['title']}")
    clashes = [b["title"] for b in books if not b["isbn"] or isbns.count(b["isbn"]) > 1]
    if clashes:  # the seed needs one ISBN per title
        raise SystemExit("Give these titles an ISBN in ISBNS and run again: " + "; ".join(clashes))


if __name__ == "__main__":
    main()
