const util = require("./util");
const FoldDict = require('./fold_dict').FoldDict;
const LazySet = require('./lazy_set').LazySet;
const settings_config = require("./settings_config");

const BinaryDict = function (pred) {
    /*
      A dictionary that keeps track of which objects had the predicate
      return true or false for efficient lookups and iteration.

      This class is an optimization for managing subscriptions.
      Typically you only subscribe to a small minority of streams, and
      most common operations want to efficiently iterate through only
      streams where the current user is subscribed:

            - search bar search
            - build left sidebar
            - autocomplete #stream_links
            - autocomplete stream in compose
    */

    const self = {};
    self.trues = new FoldDict();
    self.falses = new FoldDict();

    self.true_values = function () {
        return self.trues.values();
    };

    self.num_true_items = function () {
        return self.trues.size;
    };

    self.false_values = function () {
        return self.falses.values();
    };

    self.values = function* () {
        for (const value of self.trues.values()) {
            yield value;
        }
        for (const value of self.falses.values()) {
            yield value;
        }
    };

    self.get = function (k) {
        const res = self.trues.get(k);

        if (res !== undefined) {
            return res;
        }

        return self.falses.get(k);
    };

    self.set = function (k, v) {
        if (pred(v)) {
            self.set_true(k, v);
        } else {
            self.set_false(k, v);
        }
    };

    self.set_true = function (k, v) {
        self.falses.delete(k);
        self.trues.set(k, v);
    };

    self.set_false = function (k, v) {
        self.trues.delete(k);
        self.falses.set(k, v);
    };

    self.delete = function (k) {
        self.trues.delete(k);
        self.falses.delete(k);
    };


    return self;
};

// The stream_info variable maps stream names to stream properties objects
// Call clear_subscriptions() to initialize it.
let stream_info;
let subs_by_stream_id;
let filter_out_inactives = false;

const stream_ids_by_name = new FoldDict();
const default_stream_ids = new Set();

exports.stream_post_policy_values = {
    everyone: {
        code: 1,
        description: i18n.t("All stream members can post"),
    },
    admins: {
        code: 2,
        description: i18n.t("Only organization administrators can post"),
    },
    non_new_members: {
        code: 3,
        description: i18n.t("Only organization full members can post"),
    },
};

exports.clear_subscriptions = function () {
    stream_info = new BinaryDict(function (sub) {
        return sub.subscribed;
    });
    subs_by_stream_id = new Map();
};

exports.clear_subscriptions();

exports.set_filter_out_inactives = function () {
    if (page_params.demote_inactive_streams ===
            settings_config.demote_inactive_streams_values.automatic.code) {
        filter_out_inactives = exports.num_subscribed_subs() >= 30;
    } else if (page_params.demote_inactive_streams ===
            settings_config.demote_inactive_streams_values.always.code) {
        filter_out_inactives = true;
    } else {
        filter_out_inactives = false;
    }
};

// for testing:
exports.is_filtering_inactives = function () {
    return filter_out_inactives;
};

exports.is_active = function (sub) {
    if (!filter_out_inactives || sub.pin_to_top) {
        // If users don't want to filter inactive streams
        // to the bottom, we respect that setting and don't
        // treat any streams as dormant.
        //
        // Currently this setting is automatically determined
        // by the number of streams.  See the callers
        // to set_filter_out_inactives.
        return true;
    }
    return topic_data.stream_has_topics(sub.stream_id) || sub.newly_subscribed;
};

exports.rename_sub = function (sub, new_name) {
    const old_name = sub.name;

    stream_ids_by_name.set(old_name, sub.stream_id);

    sub.name = new_name;
    stream_info.delete(old_name);
    stream_info.set(new_name, sub);
};

exports.subscribe_myself = function (sub) {
    const user_id = people.my_current_user_id();
    exports.add_subscriber(sub.name, user_id);
    sub.subscribed = true;
    sub.newly_subscribed = true;
    stream_info.set_true(sub.name, sub);
};

exports.is_subscriber_subset = function (sub1, sub2) {
    if (sub1.subscribers && sub2.subscribers) {
        const sub2_set = sub2.subscribers;

        return Array.from(sub1.subscribers.keys()).every(key => sub2_set.has(key));
    }

    return false;
};

exports.unsubscribe_myself = function (sub) {
    // Remove user from subscriber's list
    const user_id = people.my_current_user_id();
    exports.remove_subscriber(sub.name, user_id);
    sub.subscribed = false;
    sub.newly_subscribed = false;
    stream_info.set_false(sub.name, sub);
};

exports.add_sub = function (sub) {
    if (!Object.prototype.hasOwnProperty.call(sub, 'subscribers')) {
        sub.subscribers = new LazySet([]);
    }

    stream_info.set(sub.name, sub);
    subs_by_stream_id.set(sub.stream_id, sub);
};

exports.get_sub = function (stream_name) {
    return stream_info.get(stream_name);
};

exports.get_sub_by_id = function (stream_id) {
    return subs_by_stream_id.get(stream_id);
};

exports.get_stream_id = function (name) {
    // Note: Only use this function for situations where
    // you are comfortable with a user dealing with an
    // old name of a stream (from prior to a rename).
    const sub = stream_info.get(name);

    if (sub) {
        return sub.stream_id;
    }

    const stream_id = stream_ids_by_name.get(name);
    return stream_id;
};

exports.get_sub_by_name = function (name) {
    // Note: Only use this function for situations where
    // you are comfortable with a user dealing with an
    // old name of a stream (from prior to a rename).

    const sub = stream_info.get(name);

    if (sub) {
        return sub;
    }

    const stream_id = stream_ids_by_name.get(name);

    if (!stream_id) {
        return;
    }

    return subs_by_stream_id.get(stream_id);
};

exports.id_to_slug = function (stream_id) {
    let name = exports.maybe_get_stream_name(stream_id) || 'unknown';

    // The name part of the URL doesn't really matter, so we try to
    // make it pretty.
    name = name.replace(' ', '-');

    return stream_id + '-' + name;
};

exports.name_to_slug = function (name) {
    const stream_id = exports.get_stream_id(name);

    if (!stream_id) {
        return name;
    }

    // The name part of the URL doesn't really matter, so we try to
    // make it pretty.
    name = name.replace(' ', '-');

    return stream_id + '-' + name;
};

exports.slug_to_name = function (slug) {
    const m = /^([\d]+)-/.exec(slug);
    if (m) {
        const stream_id = parseInt(m[1], 10);
        const sub = subs_by_stream_id.get(stream_id);
        if (sub) {
            return sub.name;
        }
        // if nothing was found above, we try to match on the stream
        // name in the somewhat unlikely event they had a historical
        // link to a stream like 4-horsemen
    }

    return slug;
};


exports.delete_sub = function (stream_id) {
    const sub = subs_by_stream_id.get(stream_id);
    if (!sub) {
        blueslip.warn('Failed to delete stream ' + stream_id);
        return;
    }
    subs_by_stream_id.delete(stream_id);
    stream_info.delete(sub.name);
};

exports.get_non_default_stream_names = function () {
    let subs = Array.from(stream_info.values());
    subs = subs.filter(
        sub => !exports.is_default_stream_id(sub.stream_id) && (sub.subscribed || !sub.invite_only)
    );
    const names = _.pluck(subs, 'name');
    return names;
};

exports.get_unsorted_subs = function () {
    return Array.from(stream_info.values());
};

exports.get_updated_unsorted_subs = function () {
    // This function is expensive in terms of calculating
    // some values (particularly stream counts) but avoids
    // prematurely sorting subs.
    let all_subs = Array.from(stream_info.values());

    // Add in admin options and stream counts.
    for (const sub of all_subs) {
        exports.update_calculated_fields(sub);
    }

    // We don't display unsubscribed streams to guest users.
    if (page_params.is_guest) {
        all_subs = all_subs.filter(sub => sub.subscribed);
    }

    return all_subs;
};

exports.num_subscribed_subs = function () {
    return stream_info.num_true_items();
};

exports.subscribed_subs = function () {
    return Array.from(stream_info.true_values());
};

exports.unsubscribed_subs = function () {
    return Array.from(stream_info.false_values());
};

exports.subscribed_streams = function () {
    return _.pluck(exports.subscribed_subs(), 'name');
};

exports.get_invite_stream_data = function () {
    const filter_stream_data = function (sub) {
        return {
            name: sub.name,
            stream_id: sub.stream_id,
            invite_only: sub.invite_only,
            default_stream: exports.get_default_status(sub.name),
        };
    };
    const invite_stream_data = exports.subscribed_subs().map(filter_stream_data);
    const default_stream_data = page_params.realm_default_streams.map(filter_stream_data);

    // Since, union doesn't work on array of objects we are using filter
    const is_included = new Set();
    const streams = default_stream_data.concat(invite_stream_data).filter(sub => {
        if (is_included.has(sub.name)) {
            return false;
        }
        is_included.add(sub.name);
        return true;
    });
    return streams;
};

exports.invite_streams = function () {
    const invite_list = exports.subscribed_streams();
    const default_list = _.pluck(page_params.realm_default_streams, 'name');
    return _.union(invite_list, default_list);
};

exports.get_colors = function () {
    return _.pluck(exports.subscribed_subs(), 'color');
};

exports.update_subscribers_count = function (sub) {
    const count = sub.subscribers.size;
    sub.subscriber_count = count;
};

exports.update_stream_email_address = function (sub, email) {
    sub.email_address = email;
};

exports.get_subscriber_count = function (stream_name) {
    const sub = exports.get_sub_by_name(stream_name);
    if (sub === undefined) {
        blueslip.warn('We got a get_subscriber_count count call for a non-existent stream.');
        return;
    }
    if (!sub.subscribers) {
        return 0;
    }
    return sub.subscribers.size;
};

exports.update_stream_post_policy = function (sub, stream_post_policy) {
    sub.stream_post_policy = stream_post_policy;
};

exports.update_stream_privacy = function (sub, values) {
    sub.invite_only = values.invite_only;
    sub.history_public_to_subscribers = values.history_public_to_subscribers;
};

exports.receives_notifications = function (stream_name, notification_name) {
    const sub = exports.get_sub(stream_name);
    if (sub === undefined) {
        return false;
    }
    if (sub[notification_name] !== null) {
        return sub[notification_name];
    }
    if (notification_name === 'wildcard_mentions_notify') {
        return page_params[notification_name];
    }
    return page_params["enable_stream_" + notification_name];
};

const stream_notification_settings = [
    "desktop_notifications",
    "audible_notifications",
    "push_notifications",
    "email_notifications",
    "wildcard_mentions_notify",
];

exports.update_calculated_fields = function (sub) {
    sub.is_admin = page_params.is_admin;
    // Admin can change any stream's name & description either stream is public or
    // private, subscribed or unsubscribed.
    sub.can_change_name_description = page_params.is_admin;
    // If stream is public then any user can subscribe. If stream is private then only
    // subscribed users can unsubscribe.
    // Guest users can't subscribe themselves to any stream.
    sub.should_display_subscription_button = sub.subscribed ||
        !page_params.is_guest && !sub.invite_only;
    sub.should_display_preview_button = sub.subscribed || !sub.invite_only ||
                                        sub.previously_subscribed;
    sub.can_change_stream_permissions = page_params.is_admin && (
        !sub.invite_only || sub.subscribed);
    // User can add other users to stream if stream is public or user is subscribed to stream.
    // Guest users can't access subscribers of any(public or private) non-subscribed streams.
    sub.can_access_subscribers = page_params.is_admin || sub.subscribed || !page_params.is_guest &&
                                 !sub.invite_only;
    sub.preview_url = hash_util.by_stream_uri(sub.stream_id);
    sub.can_add_subscribers = !page_params.is_guest && (!sub.invite_only || sub.subscribed);
    if (sub.rendered_description !== undefined) {
        sub.rendered_description = sub.rendered_description.replace('<p>', '').replace('</p>', '');
    }
    exports.update_subscribers_count(sub);

    // Apply the defaults for our notification settings for rendering.
    for (const setting of stream_notification_settings) {
        sub[setting + "_display"] = exports.receives_notifications(sub.name, setting);
    }
};

exports.all_subscribed_streams_are_in_home_view = function () {
    return exports.subscribed_subs().every(sub => !sub.is_muted);
};

exports.home_view_stream_names = function () {
    const home_view_subs = exports.subscribed_subs().filter(sub => !sub.is_muted);
    return home_view_subs.map(sub => sub.name);
};

exports.canonicalized_name = function (stream_name) {
    return stream_name.toString().toLowerCase();
};

exports.get_color = function (stream_name) {
    const sub = exports.get_sub(stream_name);
    if (sub === undefined) {
        return stream_color.default_color;
    }
    return sub.color;
};

exports.is_muted = function (stream_id) {
    const sub = exports.get_sub_by_id(stream_id);
    // Return true for undefined streams
    if (sub === undefined) {
        return true;
    }
    return sub.is_muted;
};

exports.is_stream_muted_by_name = function (stream_name) {
    const sub = exports.get_sub(stream_name);
    // Return true for undefined streams
    if (sub === undefined) {
        return true;
    }
    return sub.is_muted;
};

exports.is_notifications_stream_muted = function () {
    // TODO: add page_params.notifications_stream_id
    return exports.is_stream_muted_by_name(page_params.notifications_stream);
};

exports.is_subscribed = function (stream_name) {
    const sub = exports.get_sub(stream_name);
    return sub !== undefined && sub.subscribed;
};

exports.id_is_subscribed = function (stream_id) {
    const sub = subs_by_stream_id.get(stream_id);
    return sub !== undefined && sub.subscribed;
};

exports.get_invite_only = function (stream_name) {
    const sub = exports.get_sub(stream_name);
    if (sub === undefined) {
        return false;
    }
    return sub.invite_only;
};

exports.get_stream_post_policy = function (stream_name) {
    const sub = exports.get_sub(stream_name);
    if (sub === undefined) {
        return false;
    }
    return sub.stream_post_policy;
};

exports.all_topics_in_cache = function (sub) {
    // Checks whether this browser's cache of contiguous messages
    // (used to locally render narrows) in message_list.all has all
    // messages from a given stream, and thus all historical topics
    // for it.  Because message_list.all is a range, we just need to
    // compare it to the range of history on the stream.

    // If the cache isn't initialized, it's a clear false.
    if (message_list.all === undefined || message_list.all.empty()) {
        return false;
    }

    // If the cache doesn't have the latest messages, we can't be sure
    // we have all topics.
    if (!message_list.all.fetch_status.has_found_newest()) {
        return false;
    }

    if (sub.first_message_id === null) {
        // If the stream has no message history, we have it all
        // vacuously.  This should be a very rare condition, since
        // stream creation sends a message.
        return true;
    }

    // Now, we can just compare the first cached message to the first
    // message ID in the stream; if it's older, we're good, otherwise,
    // we might be missing the oldest topics in this stream in our
    // cache.
    const first_cached_message = message_list.all.first();
    return first_cached_message.id <= sub.first_message_id;
};

exports.set_realm_default_streams = function (realm_default_streams) {
    page_params.realm_default_streams = realm_default_streams;
    default_stream_ids.clear();

    realm_default_streams.forEach(function (stream) {
        default_stream_ids.add(stream.stream_id);
    });
};

exports.get_default_stream_names = function () {
    const streams = Array.from(default_stream_ids).map(exports.get_sub_by_id);
    const default_stream_names = _.pluck(streams, 'name');
    return default_stream_names;
};

exports.get_default_status = function (stream_name) {
    const stream_id = exports.get_stream_id(stream_name);

    if (!stream_id) {
        return false;
    }

    return default_stream_ids.has(stream_id);
};

exports.is_default_stream_id = function (stream_id) {
    return default_stream_ids.has(stream_id);
};

exports.get_name = function (stream_name) {
    // This returns the actual name of a stream if we are subscribed to
    // it (i.e "Denmark" vs. "denmark"), while falling thru to
    // stream_name if we don't have a subscription.  (Stream names
    // are case-insensitive, but we try to display the actual name
    // when we know it.)
    //
    // This function will also do the right thing if we have
    // an old stream name in memory for a recently renamed stream.
    const sub = exports.get_sub_by_name(stream_name);
    if (sub === undefined) {
        return stream_name;
    }
    return sub.name;
};

exports.maybe_get_stream_name = function (stream_id) {
    if (!stream_id) {
        return;
    }
    const stream = exports.get_sub_by_id(stream_id);

    if (!stream) {
        return;
    }

    return stream.name;
};

exports.set_subscribers = function (sub, user_ids) {
    sub.subscribers = new LazySet(user_ids || []);
};

exports.add_subscriber = function (stream_name, user_id) {
    const sub = exports.get_sub(stream_name);
    if (typeof sub === 'undefined') {
        blueslip.warn("We got an add_subscriber call for a non-existent stream.");
        return false;
    }
    const person = people.get_by_user_id(user_id);
    if (person === undefined) {
        blueslip.error("We tried to add invalid subscriber: " + user_id);
        return false;
    }
    sub.subscribers.add(user_id);

    return true;
};

exports.remove_subscriber = function (stream_name, user_id) {
    const sub = exports.get_sub(stream_name);
    if (typeof sub === 'undefined') {
        blueslip.warn("We got a remove_subscriber call for a non-existent stream " + stream_name);
        return false;
    }
    if (!sub.subscribers.has(user_id)) {
        blueslip.warn("We tried to remove invalid subscriber: " + user_id);
        return false;
    }

    sub.subscribers.delete(user_id);

    return true;
};

exports.is_user_subscribed = function (stream_name, user_id) {
    const sub = exports.get_sub(stream_name);
    if (typeof sub === 'undefined' || !sub.can_access_subscribers) {
        // If we don't know about the stream, or we ourselves cannot access subscriber list,
        // so we return undefined (treated as falsy if not explicitly handled).
        blueslip.warn("We got a is_user_subscribed call for a non-existent or inaccessible stream.");
        return;
    }
    if (typeof user_id === "undefined") {
        blueslip.warn("Undefined user_id passed to function is_user_subscribed");
        return;
    }

    return sub.subscribers.has(user_id);
};

exports.create_streams = function (streams) {
    for (const stream of streams) {
        // We handle subscriber stuff in other events.
        const attrs = {
            subscribers: [],
            subscribed: false,
            ...stream,
        };
        exports.create_sub_from_server_data(stream.name, attrs);
    }
};

exports.create_sub_from_server_data = function (stream_name, attrs) {
    let sub = exports.get_sub(stream_name);
    if (sub !== undefined) {
        // We've already created this subscription, no need to continue.
        return sub;
    }

    if (!attrs.stream_id) {
        // fail fast (blueslip.fatal will throw an error on our behalf)
        blueslip.fatal("We cannot create a sub without a stream_id");
        return; // this line is never actually reached
    }

    // Our internal data structure for subscriptions is mostly plain dictionaries,
    // so we just reuse the attrs that are passed in to us, but we encapsulate how
    // we handle subscribers.  We defensively remove the `subscribers` field from
    // the original `attrs` object, which will get thrown away.  (We used to make
    // a copy of the object with `_.omit(attrs, 'subscribers')`, but `_.omit` is
    // slow enough to show up in timings when you have 1000s of streams.

    const subscriber_user_ids = attrs.subscribers;

    delete attrs.subscribers;

    sub = {
        name: stream_name,
        render_subscribers: !page_params.realm_is_zephyr_mirror_realm || attrs.invite_only === true,
        subscribed: true,
        newly_subscribed: false,
        is_muted: false,
        invite_only: false,
        desktop_notifications: page_params.enable_stream_desktop_notifications,
        audible_notifications: page_params.enable_stream_audible_notifications,
        push_notifications: page_params.enable_stream_push_notifications,
        email_notifications: page_params.enable_stream_email_notifications,
        description: '',
        rendered_description: '',
        first_message_id: attrs.first_message_id,
        ...attrs,
    };

    exports.set_subscribers(sub, subscriber_user_ids);

    if (!sub.color) {
        sub.color = color_data.pick_color();
    }

    exports.update_calculated_fields(sub);

    exports.add_sub(sub);

    return sub;
};

exports.get_streams_for_settings_page = function () {
    // TODO: This function is only used for copy-from-stream, so
    //       the current name is slightly misleading now, plus
    //       it's not entirely clear we need unsubscribed streams
    //       for that.  Also we may be revisiting that UI.

    // Build up our list of subscribed streams from the data we already have.
    const subscribed_rows = exports.subscribed_subs();
    const unsubscribed_rows = exports.unsubscribed_subs();

    // Sort and combine all our streams.
    function by_name(a, b) {
        return util.strcmp(a.name, b.name);
    }
    subscribed_rows.sort(by_name);
    unsubscribed_rows.sort(by_name);
    const all_subs = unsubscribed_rows.concat(subscribed_rows);

    // Add in admin options and stream counts.
    for (const sub of all_subs) {
        exports.update_calculated_fields(sub);
    }

    return all_subs;
};

exports.sort_for_stream_settings = function (stream_ids) {
    // TODO: We may want to simply use util.strcmp here,
    //       which uses Intl.Collator() when possible.

    function name(stream_id) {
        const sub = exports.get_sub_by_id(stream_id);
        if (!sub) {
            return '';
        }
        return sub.name.toLocaleLowerCase();
    }

    function by_stream_name(id_a, id_b) {
        const stream_a_name = name(id_a);
        const stream_b_name = name(id_b);
        return String.prototype.localeCompare.call(stream_a_name, stream_b_name);
    }

    stream_ids.sort(by_stream_name);
};

exports.get_streams_for_admin = function () {
    // Sort and combine all our streams.
    function by_name(a, b) {
        return util.strcmp(a.name, b.name);
    }

    const subs = Array.from(stream_info.values());

    subs.sort(by_name);

    return subs;
};

exports.initialize = function () {
    color_data.claim_colors(page_params.subscriptions);

    function populate_subscriptions(subs, subscribed, previously_subscribed) {
        subs.forEach(function (sub) {
            const stream_name = sub.name;
            sub.subscribed = subscribed;
            sub.previously_subscribed = previously_subscribed;

            exports.create_sub_from_server_data(stream_name, sub);
        });
    }

    exports.set_realm_default_streams(page_params.realm_default_streams);

    populate_subscriptions(page_params.subscriptions, true, true);
    populate_subscriptions(page_params.unsubscribed, false, true);
    populate_subscriptions(page_params.never_subscribed, false, false);

    // Migrate the notifications stream from the new API structure to
    // what the frontend expects.
    if (page_params.realm_notifications_stream_id !== -1) {
        const notifications_stream_obj =
            exports.get_sub_by_id(page_params.realm_notifications_stream_id);
        if (notifications_stream_obj) {
            // This happens when the notifications stream is a private
            // stream the current user is not subscribed to.
            page_params.notifications_stream = notifications_stream_obj.name;
        } else {
            page_params.notifications_stream = "";
        }
    } else {
        page_params.notifications_stream = "";
    }

    exports.set_filter_out_inactives();

    // Garbage collect data structures that were only used for initialization.
    delete page_params.subscriptions;
    delete page_params.unsubscribed;
    delete page_params.never_subscribed;
};

exports.remove_default_stream = function (stream_id) {
    page_params.realm_default_streams = page_params.realm_default_streams.filter(
        stream => stream.stream_id !== stream_id
    );
    default_stream_ids.delete(stream_id);
};

window.stream_data = exports;
