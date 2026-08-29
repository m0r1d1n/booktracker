import datetime
import enum

from sqlalchemy import (
    Column,
    Integer,
    String,
    Boolean,
    Date,
    DateTime,
    Text,
    ForeignKey,
    Table,
)
from sqlalchemy.orm import relationship

from database import Base


class ReadStatus(str, enum.Enum):
    unread = "unread"
    planning = "planning"
    reading = "reading"
    read = "read"
    dnf = "dnf"  # did not finish


book_tags = Table(
    "book_tags",
    Base.metadata,
    Column("book_id", Integer, ForeignKey("books.id"), primary_key=True),
    Column("tag_id", Integer, ForeignKey("tags.id"), primary_key=True),
)


class Tag(Base):
    __tablename__ = "tags"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), unique=True, nullable=False, index=True)


class Book(Base):
    __tablename__ = "books"

    id = Column(Integer, primary_key=True, index=True)
    isbn = Column(String(20), index=True, nullable=True)
    title = Column(String(500), nullable=False)
    authors = Column(String(500), nullable=True)  # comma-separated
    publisher = Column(String(300), nullable=True)
    published_date = Column(String(50), nullable=True)
    page_count = Column(Integer, nullable=True)
    description = Column(Text, nullable=True)
    cover_url = Column(String(500), nullable=True)
    genre = Column(String(200), nullable=True)  # legacy free-text field, superseded by tags
    location = Column(String(200), nullable=True, index=True)
    series = Column(String(200), nullable=True, index=True)

    owned = Column(Boolean, default=True)
    # plain String rather than SQLAlchemy Enum: an Enum column bakes in a CHECK
    # constraint listing the allowed values at table-creation time, which
    # blocks adding new statuses later without a table rebuild. Validation of
    # allowed values happens at the Pydantic layer instead.
    status = Column(String(20), default=ReadStatus.unread.value, index=True)
    date_started = Column(Date, nullable=True)
    date_finished = Column(Date, nullable=True)
    rating = Column(Integer, nullable=True)  # 1-5, nullable

    added_at = Column(DateTime, default=datetime.datetime.utcnow)

    review = relationship(
        "Review", back_populates="book", uselist=False, cascade="all, delete-orphan"
    )
    tags = relationship("Tag", secondary=book_tags, backref="books")


class Review(Base):
    __tablename__ = "reviews"

    id = Column(Integer, primary_key=True, index=True)
    book_id = Column(Integer, ForeignKey("books.id"), unique=True, nullable=False)
    review_text = Column(Text, nullable=False, default="")
    contains_spoilers = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(
        DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow
    )

    book = relationship("Book", back_populates="review")
