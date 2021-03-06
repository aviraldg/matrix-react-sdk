/*
Copyright 2015, 2016 OpenMarket Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
var React = require('react');
var classNames = require('classnames');
var Matrix = require("matrix-js-sdk");
var q = require('q');
var MatrixClientPeg = require("../../../MatrixClientPeg");
var Modal = require("../../../Modal");
var Entities = require("../../../Entities");
var sdk = require('../../../index');
var GeminiScrollbar = require('react-gemini-scrollbar');
var rate_limited_func = require('../../../ratelimitedfunc');

var INITIAL_LOAD_NUM_MEMBERS = 30;
var SHARE_HISTORY_WARNING =
    <span>
        Newly invited users will see the history of this room. <br/>
        If you'd prefer invited users not to see messages that were sent before they joined, <br/>
        turn off, 'Share message history with new users' in the settings for this room.
    </span>

var shown_invite_warning_this_session = false;
// global promise so people can bulk invite and they all get resolved
var invite_defer = q.defer();

module.exports = React.createClass({
    displayName: 'MemberList',

    getInitialState: function() {
        var state = {
            members: [],
            // ideally we'd size this to the page height, but
            // in practice I find that a little constraining
            truncateAt: INITIAL_LOAD_NUM_MEMBERS,
        };
        if (!this.props.roomId) return state;
        var cli = MatrixClientPeg.get();
        var room = cli.getRoom(this.props.roomId);
        if (!room) return state;

        this.memberDict = this.getMemberDict();

        state.members = this.roomMembers(INITIAL_LOAD_NUM_MEMBERS);
        return state;
    },

    componentWillMount: function() {
        var cli = MatrixClientPeg.get();
        cli.on("RoomState.members", this.onRoomStateMember);
        cli.on("RoomMember.name", this.onRoomMemberName);
        cli.on("RoomState.events", this.onRoomStateEvent);
        cli.on("Room", this.onRoom); // invites
    },

    componentWillUnmount: function() {
        if (MatrixClientPeg.get()) {
            MatrixClientPeg.get().removeListener("Room", this.onRoom);
            MatrixClientPeg.get().removeListener("RoomState.members", this.onRoomStateMember);
            MatrixClientPeg.get().removeListener("RoomMember.name", this.onRoomMemberName);
            MatrixClientPeg.get().removeListener("User.presence", this.userPresenceFn);
            MatrixClientPeg.get().removeListener("RoomState.events", this.onRoomStateEvent);
        }
    },

    componentDidMount: function() {
        var self = this;

        // Lazy-load in more than the first N members
        setTimeout(function() {
            if (!self.isMounted()) return;
            // lazy load to prevent it blocking the first render
            self.setState({
                members: self.roomMembers()
            });
        }, 50);

        // Attach a SINGLE listener for global presence changes then locate the
        // member tile and re-render it. This is more efficient than every tile
        // evar attaching their own listener.
        function updateUserState(event, user) {
            // XXX: evil hack to track the age of this presence info.
            // this should be removed once syjs-28 is resolved in the JS SDK itself.
            user.lastPresenceTs = Date.now();

            var tile = self.refs[user.userId];

            if (tile) {
                self._updateList(); // reorder the membership list
            }
        }
        // FIXME: we should probably also reset 'lastActiveAgo' to zero whenever
        // we see a typing notif from a user, as we don't get presence updates for those.
        MatrixClientPeg.get().on("User.presence", updateUserState);
        this.userPresenceFn = updateUserState;
    },

    onRoom: function(room) {
        if (room.roomId !== this.props.roomId) {
            return;
        }
        // We listen for room events because when we accept an invite
        // we need to wait till the room is fully populated with state
        // before refreshing the member list else we get a stale list.
        this._updateList();
    },

    onRoomStateMember: function(ev, state, member) {
        this._updateList();
    },

    onRoomMemberName: function(ev, member) {
        this._updateList();
    },

    onRoomStateEvent: function(event, state) {
        if (event.getType() === "m.room.third_party_invite") {
            this._updateList();
        }
    },

    _updateList: new rate_limited_func(function() {
        this.memberDict = this.getMemberDict();

        var self = this;
        this.setState({
            members: self.roomMembers()
        });
    }, 500),

    onInvite: function(inputText) {
        var ErrorDialog = sdk.getComponent("dialogs.ErrorDialog");
        var self = this;
        inputText = inputText.trim(); // react requires es5-shim so we know trim() exists

        // email addresses and user IDs do not allow space, comma, semicolon so split
        // on them for bulk inviting.
        var separators =[ ";", " ", "," ];
        for (var i = 0; i < separators.length; i++) {
            if (inputText.indexOf(separators[i]) >= 0) {
                var inputs = inputText.split(separators[i]);
                inputs.forEach(function(input) {
                    self.onInvite(input);
                });
                return;
            }
        }

        var isEmailAddress = /^\S+@\S+\.\S+$/.test(inputText);

        // sanity check the input for user IDs
        if (!isEmailAddress && (inputText[0] !== '@' || inputText.indexOf(":") === -1)) {
            console.error("Bad ID to invite: %s", inputText);
            Modal.createDialog(ErrorDialog, {
                title: "Invite Error",
                description: "Malformed ID. Should be an email address or a Matrix ID like '@localpart:domain'"
            });
            return;
        }

        var inviteWarningDefer = q.defer();

        var room = MatrixClientPeg.get().getRoom(this.props.roomId);
        var history_visibility = room.currentState.getStateEvents('m.room.history_visibility', '');
        if (history_visibility) history_visibility = history_visibility.getContent().history_visibility;

        if (history_visibility == 'shared' && !shown_invite_warning_this_session) {
            inviteWarningDefer = invite_defer; // whether we continue depends on this defer
            var QuestionDialog = sdk.getComponent("dialogs.QuestionDialog");
            Modal.createDialog(QuestionDialog, {
                title: "Warning",
                description: SHARE_HISTORY_WARNING,
                button: "Invite",
                onFinished: function(should_invite) {
                    if (should_invite) {
                        shown_invite_warning_this_session = true;
                        invite_defer.resolve();
                    } else {
                        invite_defer.reject(null);
                        // reset the promise so we don't auto-reject all invites from
                        // now on.
                        invite_defer = q.defer();
                    }
                }
            });
        } else {
            inviteWarningDefer.resolve();
        }

        var promise = inviteWarningDefer.promise;
        if (isEmailAddress) {
            promise = promise.then(function() {
                 return MatrixClientPeg.get().inviteByEmail(self.props.roomId, inputText);
            });
        }
        else {
            promise = promise.then(function() {
                return MatrixClientPeg.get().invite(self.props.roomId, inputText);
            });
        }

        self.setState({
            inviting: true
        });
        console.log(
            "Invite %s to %s - isEmail=%s", inputText, this.props.roomId, isEmailAddress
        );
        promise.done(function(res) {
            console.log("Invited %s", inputText);
            self.setState({
                inviting: false
            });
        }, function(err) {
            if (err !== null) {
                console.error("Failed to invite: %s", JSON.stringify(err));
                Modal.createDialog(ErrorDialog, {
                    title: "Server error whilst inviting",
                    description: err.message
                });
            }
            self.setState({
                inviting: false
            });
        });
    },

    getMemberDict: function() {
        if (!this.props.roomId) return {};
        var cli = MatrixClientPeg.get();
        var room = cli.getRoom(this.props.roomId);
        if (!room) return {};

        var all_members = room.currentState.members;

        // XXX: evil hack until SYJS-28 is fixed
        Object.keys(all_members).map(function(userId) {
            // work around a race where you might have a room member object
            // before the user object exists.  This may or may not cause
            // https://github.com/vector-im/vector-web/issues/186
            if (all_members[userId].user === null) {
                all_members[userId].user = MatrixClientPeg.get().getUser(userId);
            }

            if (all_members[userId].user && !all_members[userId].user.lastPresenceTs) {
                all_members[userId].user.lastPresenceTs = Date.now();
            }
        });

        return all_members;
    },

    roomMembers: function(limit) {
        var all_members = this.memberDict || {};
        var all_user_ids = Object.keys(all_members);

        if (this.memberSort) all_user_ids.sort(this.memberSort);

        var to_display = [];
        var count = 0;
        for (var i = 0; i < all_user_ids.length && (limit === undefined || count < limit); ++i) {
            var user_id = all_user_ids[i];
            var m = all_members[user_id];

            if (m.membership == 'join' || m.membership == 'invite') {
                to_display.push(user_id);
                ++count;
            }
        }
        return to_display;
    },

    _createOverflowTile: function(overflowCount, totalCount) {
        // For now we'll pretend this is any entity. It should probably be a separate tile.
        var EntityTile = sdk.getComponent("rooms.EntityTile");
        var BaseAvatar = sdk.getComponent("avatars.BaseAvatar");
        var text = "and " + overflowCount + " other" + (overflowCount > 1 ? "s" : "") +  "...";
        return (
            <EntityTile className="mx_EntityTile_ellipsis" avatarJsx={
                <BaseAvatar url="img/ellipsis.svg" name="..." width={36} height={36} />
            } name={text} presenceState="online" suppressOnHover={true}
            onClick={this._showFullMemberList} />
        );
    },

    _showFullMemberList: function() {
        this.setState({
            truncateAt: -1
        });
    },

    memberSort: function(userIdA, userIdB) {
        var userA = this.memberDict[userIdA].user;
        var userB = this.memberDict[userIdB].user;

        var presenceMap = {
            online: 3,
            unavailable: 2,
            offline: 1
        };

        var presenceOrdA = userA ? presenceMap[userA.presence] : 0;
        var presenceOrdB = userB ? presenceMap[userB.presence] : 0;

        if (presenceOrdA != presenceOrdB) {
            return presenceOrdB - presenceOrdA;
        }

        var latA = userA ? (userA.lastPresenceTs - (userA.lastActiveAgo || userA.lastPresenceTs)) : 0;
        var latB = userB ? (userB.lastPresenceTs - (userB.lastActiveAgo || userB.lastPresenceTs)) : 0;

        return latB - latA;
    },

    onSearchQueryChanged: function(input) {
        this.setState({
            searchQuery: input
        });
    },

    makeMemberTiles: function(membership, query) {
        var MemberTile = sdk.getComponent("rooms.MemberTile");
        query = (query || "").toLowerCase();

        var self = this;

        var memberList = self.state.members.filter(function(userId) {
            var m = self.memberDict[userId];
            if (query && m.name.toLowerCase().indexOf(query) === -1) {
                return false;
            }
            return m.membership == membership;
        }).map(function(userId) {
            var m = self.memberDict[userId];
            return (
                <MemberTile key={userId} member={m} ref={userId} />
            );
        });

        if (membership === "invite") {
            // include 3pid invites (m.room.third_party_invite) state events.
            // The HS may have already converted these into m.room.member invites so
            // we shouldn't add them if the 3pid invite state key (token) is in the
            // member invite (content.third_party_invite.signed.token)
            var room = MatrixClientPeg.get().getRoom(this.props.roomId);
            var EntityTile = sdk.getComponent("rooms.EntityTile");
            if (room) {
                room.currentState.getStateEvents("m.room.third_party_invite").forEach(
                function(e) {
                    // discard all invites which have a m.room.member event since we've
                    // already added them.
                    var memberEvent = room.currentState.getInviteForThreePidToken(e.getStateKey());
                    if (memberEvent) {
                        return;
                    }
                    memberList.push(
                        <EntityTile key={e.getStateKey()} name={e.getContent().display_name} />
                    )
                })
            }
        }

        return memberList;
    },

    render: function() {
        var InviteMemberList = sdk.getComponent("rooms.InviteMemberList");

        var invitedSection = null;
        var invitedMemberTiles = this.makeMemberTiles('invite', this.state.searchQuery);
        if (invitedMemberTiles.length > 0) {
            invitedSection = (
                <div className="mx_MemberList_invited">
                    <h2>Invited</h2>
                    <div autoshow={true} className="mx_MemberList_wrapper">
                        {invitedMemberTiles}
                    </div>
                </div>
            );
        }

        var inviteMemberListSection;
        if (this.state.inviting) {
            var Loader = sdk.getComponent("elements.Spinner");
            inviteMemberListSection = (
                <Loader />
            );
        }
        else {
            inviteMemberListSection = (
                <InviteMemberList roomId={this.props.roomId}
                    onSearchQueryChanged={this.onSearchQueryChanged}
                    onInvite={this.onInvite} />
            );
        }


        var TruncatedList = sdk.getComponent("elements.TruncatedList");
        return (
            <div className="mx_MemberList">
                    {inviteMemberListSection}
                    <GeminiScrollbar autoshow={true} className="mx_MemberList_joined mx_MemberList_outerWrapper">
                        <TruncatedList className="mx_MemberList_wrapper" truncateAt={this.state.truncateAt}
                                createOverflowElement={this._createOverflowTile}>
                            {this.makeMemberTiles('join', this.state.searchQuery)}
                        </TruncatedList>
                        {invitedSection}
                    </GeminiScrollbar>
                    <div className="mx_MemberList_bottom">
                        <div className="mx_MemberList_bottomRule">
                        </div>
                    </div>
            </div>
        );
    }
});

