import { useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { auth, db } from "./firebase";

function formatTime(value) {
  if (!value) return "sending...";
  const date = value.toDate ? value.toDate() : value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getChatId(uidA, uidB) {
  return [uidA, uidB].sort().join("__");
}

export default function App() {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [currentUser, setCurrentUser] = useState(null);
  const [fixedUsername, setFixedUsername] = useState("");
  const [searchName, setSearchName] = useState("");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState([]);
  const [friends, setFriends] = useState([]);
  const [incomingRequests, setIncomingRequests] = useState([]);
  const [activeFriend, setActiveFriend] = useState(null);
  const [status, setStatus] = useState("Please log in");
  const [authError, setAuthError] = useState("");
  const [friendError, setFriendError] = useState("");
  const endRef = useRef(null);

  const normalizedUsername = useMemo(() => username.trim().toLowerCase(), [username]);
  const normalizedSearchName = useMemo(() => searchName.trim().toLowerCase(), [searchName]);
  const trimmedName = useMemo(() => fixedUsername.trim(), [fixedUsername]);
  const trimmedDraft = useMemo(() => draft.trim(), [draft]);
  const activeChatId = useMemo(
    () => (currentUser && activeFriend ? getChatId(currentUser.uid, activeFriend.uid) : ""),
    [currentUser, activeFriend]
  );

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!currentUser || !trimmedName || !activeChatId) {
      setMessages([]);
      return;
    }

    setStatus(`Chatting with @${activeFriend.username}`);

    const messagesRef = collection(db, "chats", activeChatId, "messages");
    const messagesQuery = query(messagesRef, orderBy("createdAt", "asc"));

    const unsubscribe = onSnapshot(
      messagesQuery,
      (snapshot) => {
        const nextMessages = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));

        setMessages(nextMessages);
        setStatus("Connected");
      },
      () => {
        setStatus("Failed to load messages.");
      }
    );

    return () => unsubscribe();
  }, [activeChatId, activeFriend, currentUser, trimmedName]);

  useEffect(() => {
    if (!currentUser) {
      setFriends([]);
      return;
    }

    const friendsRef = collection(db, "users", currentUser.uid, "friends");
    const friendsQuery = query(friendsRef, orderBy("username", "asc"));

    const unsubscribe = onSnapshot(friendsQuery, (snapshot) => {
      const nextFriends = snapshot.docs.map((item) => ({
        uid: item.id,
        ...item.data(),
      }));
      setFriends(nextFriends);

      setActiveFriend((prev) => {
        if (!prev) return nextFriends[0] || null;
        const stillExists = nextFriends.some((friend) => friend.uid === prev.uid);
        return stillExists ? prev : nextFriends[0] || null;
      });
    });

    return () => unsubscribe();
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) {
      setIncomingRequests([]);
      return;
    }

    const requestsRef = collection(db, "friendRequests");
    const requestsQuery = query(requestsRef, where("toUid", "==", currentUser.uid));

    const unsubscribe = onSnapshot(requestsQuery, (snapshot) => {
      const next = snapshot.docs
        .map((item) => ({ id: item.id, ...item.data() }))
        .filter((request) => request.status === "pending");
      setIncomingRequests(next);
    });

    return () => unsubscribe();
  }, [currentUser]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = async () => {
    if (!currentUser || !trimmedName || !activeChatId || !trimmedDraft) return;

    setDraft("");

    await addDoc(collection(db, "chats", activeChatId, "messages"), {
      authorUid: currentUser.uid,
      authorUsername: trimmedName,
      text: trimmedDraft,
      createdAt: serverTimestamp(),
    });
  };

  const onKeyDown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      sendMessage();
    }
  };

  const sendFriendRequest = async () => {
    setFriendError("");
    if (!currentUser || !trimmedName || !normalizedSearchName) return;

    if (normalizedSearchName === trimmedName) {
      setFriendError("You cannot add yourself.");
      return;
    }

    const targetRef = doc(db, "usernames", normalizedSearchName);
    const targetDoc = await getDoc(targetRef);

    if (!targetDoc.exists()) {
      setFriendError("Username not found.");
      return;
    }

    const targetData = targetDoc.data();
    const targetUid = targetData.uid;

    if (friends.some((friend) => friend.uid === targetUid)) {
      setFriendError("User is already your friend.");
      return;
    }

    const requestId = `${currentUser.uid}__${targetUid}`;
    const existingRequest = await getDoc(doc(db, "friendRequests", requestId));
    if (existingRequest.exists() && existingRequest.data().status === "pending") {
      setFriendError("Friend request already sent.");
      return;
    }

    await setDoc(doc(db, "friendRequests", requestId), {
      fromUid: currentUser.uid,
      fromUsername: trimmedName,
      toUid: targetUid,
      toUsername: normalizedSearchName,
      status: "pending",
      createdAt: serverTimestamp(),
    });

    setSearchName("");
  };

  const acceptRequest = async (requestItem) => {
    if (!currentUser) return;
    const chatId = getChatId(requestItem.fromUid, requestItem.toUid);
    const batch = writeBatch(db);

    batch.update(doc(db, "friendRequests", requestItem.id), {
      status: "accepted",
      respondedAt: serverTimestamp(),
    });

    batch.set(doc(db, "users", requestItem.fromUid, "friends", requestItem.toUid), {
      username: requestItem.toUsername,
      addedAt: serverTimestamp(),
    });

    batch.set(doc(db, "users", requestItem.toUid, "friends", requestItem.fromUid), {
      username: requestItem.fromUsername,
      addedAt: serverTimestamp(),
    });

    batch.set(
      doc(db, "chats", chatId),
      {
        members: [requestItem.fromUid, requestItem.toUid],
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    await batch.commit();
  };

  const rejectRequest = async (requestItem) => {
    await updateDoc(doc(db, "friendRequests", requestItem.id), {
      status: "rejected",
      respondedAt: serverTimestamp(),
    });
  };

  const onAuthSubmit = async (event) => {
    event.preventDefault();
    setAuthError("");

    if (!normalizedUsername || !password || (mode === "register" && !email.trim())) {
      setAuthError("Fill all required fields.");
      return;
    }

    try {
      if (mode === "register") {
        const usernameRef = doc(db, "usernames", normalizedUsername);
        const existing = await getDoc(usernameRef);

        if (existing.exists()) {
          setAuthError("Username is already taken.");
          return;
        }

        const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);

        await setDoc(usernameRef, {
          uid: credential.user.uid,
          email: email.trim(),
          username: normalizedUsername,
        });

        await setDoc(doc(db, "users", credential.user.uid), {
          username: normalizedUsername,
          email: email.trim(),
          createdAt: serverTimestamp(),
        });

        setUsername("");
        setEmail("");
        setPassword("");
        return;
      }

      const usernameRef = doc(db, "usernames", normalizedUsername);
      const usernameDoc = await getDoc(usernameRef);

      if (!usernameDoc.exists()) {
        setAuthError("Username not found.");
        return;
      }

      const { email: loginEmail } = usernameDoc.data();
      await signInWithEmailAndPassword(auth, loginEmail, password);
      setUsername("");
      setPassword("");
    } catch (err) {
      setAuthError(err?.message || "Authentication failed.");
    }
  };

  const handleSignOut = async () => {
    await signOut(auth);
    setMessages([]);
    setFriends([]);
    setIncomingRequests([]);
    setActiveFriend(null);
    setStatus("Please log in");
    setFixedUsername("");
  };

  useEffect(() => {
    if (!currentUser) return;
    getDoc(doc(db, "users", currentUser.uid)).then((userDoc) => {
      if (userDoc.exists()) {
        const nextUsername = userDoc.data().username || "";
        setFixedUsername(nextUsername);
      }
    });
  }, [currentUser]);

  return (
    <main className="chat-page">
      <section className="chat-card">
        <header className="chat-header">Friend Chat</header>

        {!currentUser ? (
          <section className="auth-panel">
            <div className="auth-mode-row">
              <button className={mode === "login" ? "tab active" : "tab"} onClick={() => setMode("login")}>
                Login
              </button>
              <button className={mode === "register" ? "tab active" : "tab"} onClick={() => setMode("register")}>
                Register
              </button>
            </div>

            <form className="auth-form" onSubmit={onAuthSubmit}>
              <label>
                Username
                <input
                  type="text"
                  placeholder="yourname"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </label>

              {mode === "register" && (
                <label>
                  Email
                  <input
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </label>
              )}

              <label>
                Password
                <input
                  type="password"
                  placeholder="******"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>

              {authError && <p className="auth-error">{authError}</p>}
              <button type="submit">{mode === "register" ? "Create account" : "Login"}</button>
            </form>
          </section>
        ) : (
          <>
            <section className="chat-layout">
              <aside className="friends-panel">
                <div className="self-row">
                  <div className="self-name">@{trimmedName}</div>
                  <button className="logout-btn" onClick={handleSignOut}>
                    Logout
                  </button>
                </div>

                <div className="add-friend-row">
                  <input
                    type="text"
                    placeholder="Search username"
                    value={searchName}
                    onChange={(event) => setSearchName(event.target.value)}
                  />
                  <button onClick={sendFriendRequest} disabled={!normalizedSearchName}>
                    Add
                  </button>
                </div>
                {friendError && <p className="auth-error">{friendError}</p>}

                <section className="request-list">
                  <h3>Requests</h3>
                  {incomingRequests.length === 0 && <p className="empty-state">No requests</p>}
                  {incomingRequests.map((item) => (
                    <article key={item.id} className="request-item">
                      <span>@{item.fromUsername}</span>
                      <div>
                        <button className="small-btn" onClick={() => acceptRequest(item)}>
                          Accept
                        </button>
                        <button className="small-btn ghost" onClick={() => rejectRequest(item)}>
                          Reject
                        </button>
                      </div>
                    </article>
                  ))}
                </section>

                <section className="friends-list">
                  <h3>Friends</h3>
                  {friends.length === 0 && <p className="empty-state">No friends yet</p>}
                  {friends.map((friend) => (
                    <button
                      key={friend.uid}
                      className={activeFriend?.uid === friend.uid ? "friend-btn active" : "friend-btn"}
                      onClick={() => setActiveFriend(friend)}
                    >
                      @{friend.username}
                    </button>
                  ))}
                </section>
              </aside>

              <section className="chat-main">
                <div className="chat-status">{activeFriend ? status : "Select a friend to start chatting"}</div>

                <div className="chat-messages" role="log" aria-live="polite">
                  {messages.length === 0 && <p className="empty-state">No messages yet</p>}

                  {messages.map((msg) => (
                    <article
                      key={msg.id}
                      className={`msg ${msg.authorUid === currentUser.uid ? "msg-you" : "msg-other"}`}
                    >
                      <div className="msg-meta">
                        <span>@{msg.authorUsername || "unknown"}</span>
                        <time>{formatTime(msg.createdAt)}</time>
                      </div>
                      <p>{msg.text}</p>
                    </article>
                  ))}

                  <div ref={endRef} />
                </div>

                <footer className="chat-input-row">
                  <input
                    type="text"
                    placeholder={activeFriend ? "Type message" : "Select a friend first"}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={onKeyDown}
                    aria-label="Message input"
                    disabled={!activeFriend}
                  />
                  <button onClick={sendMessage} disabled={!activeFriend || !trimmedDraft}>
                    Send
                  </button>
                </footer>
              </section>
            </section>
          </>
        )}
      </section>
    </main>
  );
}
